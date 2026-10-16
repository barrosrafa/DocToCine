import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pLimit from 'p-limit';
import type { ChapterBoundary } from '../../domain/schemas/chapter.schema.js';
import type { VideoScript } from '../../domain/schemas/script.schema.js';
import type { VisualMode } from '../../domain/schemas/scene.schema.js';
import { ArtifactStore, atomicJson, stableHash } from '../../infra/storage/artifact-store.js';
import { SharpSceneProvider } from '../../infra/media/sharp-scene-provider.js';
import { OpenRouterSceneProvider } from '../../infra/media/openrouter-scene-provider.js';
import { ShotCompositor } from '../../infra/media/shot-compositor.js';
import { FakeTtsProvider } from '../../infra/tts/fake-tts-provider.js';
import { writeSrt } from '../../infra/media/srt-builder.js';
import { writeAss } from '../../infra/media/ass-builder.js';
import { FfmpegRenderer } from '../../infra/media/ffmpeg-renderer.js';
import { checkVideo } from '../../infra/media/video-quality-checker.js';
import { concatenateAndNormalizeAudio } from '../../infra/media/audio-normalizer.js';
import { planVideoShots } from '../services/scene-planner.js';
import { buildSubtitleCues } from '../services/subtitle-cue-builder.js';
import { ApproximateAligner } from '../services/approximate-aligner.js';
import { type VideoManifest } from '../../domain/schemas/video.schema.js';
import type { TtsProvider } from '../../domain/ports/tts-provider.js';
import type { SceneAssetProvider } from '../../domain/ports/scene-provider.js';
import type { AlignmentProvider } from '../../domain/ports/alignment-provider.js';
import { AppError } from '../../core/errors/app-error.js';
import type { JobReporter } from '../services/job-reporter.js';
import type { CostGuard } from '../services/cost-guard.js';

export type VideoPipelineOptions = {
  fps?: number;
  crf?: number;
  preset?: string;
  sceneConcurrency?: number;
  visualShotTargetSeconds?: number;
  aiImageMinIntervalSeconds?: number;
  maxGeneratedImagesPerVideo?: number;
  visualMode?: VisualMode;
  enableWordAlignment?: boolean;
  alignmentProvider?: 'whisperx' | 'approximate';
  aligner?: AlignmentProvider;
  captionFontName?: string;
  allowSyntheticFixture?: boolean;
  resume?: boolean;
  force?: boolean;
  reporter?: JobReporter;
  costGuard?: CostGuard;
};

export class VideoPipeline {
  private readonly sceneProvider: SceneAssetProvider;
  private readonly ttsProvider: TtsProvider;
  private readonly options: VideoPipelineOptions;

  constructor(
    readonly store: ArtifactStore,
    readonly width = 1280,
    readonly height = 720,
    readonly burnCaptions = true,
    sceneProvider?: SceneAssetProvider,
    ttsProvider?: TtsProvider,
    options: VideoPipelineOptions = {},
  ) {
    this.sceneProvider = sceneProvider ?? new SharpSceneProvider(this.width, this.height);
    this.ttsProvider = ttsProvider ?? new FakeTtsProvider();
    this.options = options;
  }

  async render(
    script: VideoScript,
    chapter: ChapterBoundary,
    runOverrides: { resume?: boolean; force?: boolean } = {},
  ): Promise<string> {
    const dir = this.store.videoDir(chapter.number, script.durationMinutes);
    const outVideoPath = resolve(dir, 'video.mp4');
    const resume = runOverrides.resume ?? this.options.resume ?? false;
    const force = runOverrides.force ?? this.options.force ?? false;
    const fps = this.options.fps ?? 30;
    const crf = this.options.crf ?? 20;
    const preset = this.options.preset ?? 'medium';
    const aspectRatio: '16:9' | '9:16' = this.height > this.width ? '9:16' : '16:9';

    const scriptHash = stableHash({
      title: script.title,
      durationMinutes: script.durationMinutes,
      narration: script.narration,
      segments: script.segments,
    });
    const configHash = stableHash({
      width: this.width,
      height: this.height,
      fps,
      crf,
      preset,
      burnCaptions: this.burnCaptions,
      visualMode: this.options.visualMode ?? 'balanced',
      visualShotTargetSeconds: this.options.visualShotTargetSeconds ?? 8,
    });

    if (resume && !force) {
      const existingManifest = await this.store.loadManifest(
        chapter.number,
        script.durationMinutes,
      );
      if (
        existingManifest?.status === 'completed' &&
        existingManifest.scriptHash === scriptHash &&
        existingManifest.configHash === configHash
      ) {
        try {
          await access(outVideoPath);
          this.options.reporter?.record({
            event: 'scene.reused',
            stage: 'render',
            chapter: chapter.number,
            durationPreset: script.durationMinutes,
            elapsedMs: 0,
          });
          return outVideoPath;
        } catch {
          // Proceed with fresh render if file is missing
        }
      }
    }

    await mkdir(resolve(dir, 'assets'), { recursive: true });
    await mkdir(resolve(dir, 'scenes'), { recursive: true });
    await mkdir(resolve(dir, 'audio'), { recursive: true });

    const warnings: string[] = [...(script.warnings ?? [])];
    await atomicJson(resolve(dir, 'script.json'), script);

    // 1. Synthesize audio per segment first so timeline is grounded in real speech durations
    this.options.costGuard?.assertWithinBudget();
    const ttsStart = Date.now();
    const audio = await this.ttsProvider.synthesizeSegments(script.segments, resolve(dir, 'audio'));
    if (audio.warnings?.length) warnings.push(...audio.warnings);

    const ttsDegraded = Boolean(audio.degraded);
    const ttsWasSyntheticFixture = Boolean(
      audio.usedModels?.some((m) => m.startsWith('synthetic-fixture')),
    );

    this.options.reporter?.record({
      event: 'tts.completed',
      stage: 'tts',
      chapter: chapter.number,
      durationPreset: script.durationMinutes,
      ...(audio.usedModels?.[0] !== undefined ? { usedModel: audio.usedModels[0] } : {}),
      elapsedMs: Date.now() - ttsStart,
      degraded: ttsDegraded,
    });

    // 2. Concatenate and normalize segment audio files into narration.mp3
    const segmentAudioPaths = audio.timed.map(
      (t) => t.path ?? resolve(dir, 'audio', `${t.segmentId}.mp3`),
    );
    const audioPath = resolve(dir, 'audio', 'narration.mp3');
    const normalizedAudio = await concatenateAndNormalizeAudio(segmentAudioPaths, audioPath, {
      normalizeLoudness: true,
    });

    await atomicJson(resolve(dir, 'audio', 'audio_timing.json'), {
      totalDurationSeconds: normalizedAudio.durationSeconds,
      segments: audio.timed,
      degraded: ttsDegraded,
      usedModels: audio.usedModels ?? [],
    });

    // 3. Word/phrase alignment
    const alignStart = Date.now();
    const approxAligner = new ApproximateAligner();
    let alignment = await approxAligner.alignSegments(
      audio.timed.map((t) => ({
        segmentId: t.segmentId,
        text: t.text,
        startSeconds: t.startSeconds,
        endSeconds: t.endSeconds,
      })),
    );

    if (
      (this.options.enableWordAlignment ?? true) &&
      this.options.alignmentProvider === 'whisperx' &&
      this.options.aligner
    ) {
      alignment = await this.options.aligner.align({
        audioPath,
        transcript: script.segments.map((s) => s.text).join(' '),
        language: 'pt',
        durationSeconds: normalizedAudio.durationSeconds,
      });
    } else if (this.options.aligner?.alignSegments) {
      alignment = await this.options.aligner.alignSegments(
        audio.timed.map((t) => ({
          segmentId: t.segmentId,
          text: t.text,
          startSeconds: t.startSeconds,
          endSeconds: t.endSeconds,
        })),
      );
    }

    if (alignment.warnings.length) warnings.push(...alignment.warnings);
    const alignmentPath = resolve(dir, 'alignment.json');
    await atomicJson(alignmentPath, alignment);

    this.options.reporter?.record({
      event: 'alignment.completed',
      stage: 'alignment',
      chapter: chapter.number,
      durationPreset: script.durationMinutes,
      elapsedMs: Date.now() - alignStart,
      degraded: alignment.method !== 'forced-alignment',
    });

    // 4. Build subtitle cues and write SRT + ASS
    const cues = buildSubtitleCues(alignment.words, { aspectRatio });
    const captionsPath = resolve(dir, 'captions.srt');
    const assCaptionsPath = resolve(dir, 'captions.ass');
    await writeSrt(cues, captionsPath);
    await writeAss(cues, assCaptionsPath, {
      width: this.width,
      height: this.height,
      ...(this.options.captionFontName !== undefined
        ? { fontName: this.options.captionFontName }
        : {}),
    });

    // 5. Plan visual shots over real speech timeline
    const shotPlan = planVideoShots(
      script,
      audio.timed.map((t) => ({
        segmentId: t.segmentId,
        text: t.text,
        startSeconds: t.startSeconds,
        endSeconds: t.endSeconds,
      })),
      {
        ...(this.options.visualShotTargetSeconds !== undefined
          ? { targetShotSeconds: this.options.visualShotTargetSeconds }
          : {}),
        ...(this.options.aiImageMinIntervalSeconds !== undefined
          ? { aiImageMinIntervalSeconds: this.options.aiImageMinIntervalSeconds }
          : {}),
        ...(this.options.maxGeneratedImagesPerVideo !== undefined
          ? { maxGeneratedImagesPerVideo: this.options.maxGeneratedImagesPerVideo }
          : {}),
        ...(this.options.visualMode !== undefined ? { visualMode: this.options.visualMode } : {}),
        aspectRatio,
      },
    );

    // Adjust final shot end so total shot duration matches normalized audio duration closely
    if (shotPlan.shots.length > 0 && normalizedAudio.durationSeconds > 0) {
      const lastShot = shotPlan.shots.at(-1)!;
      if (normalizedAudio.durationSeconds > lastShot.startSeconds + 0.2) {
        lastShot.endSeconds = Number(normalizedAudio.durationSeconds.toFixed(3));
        shotPlan.totalDurationSeconds = lastShot.endSeconds;
      }
    }

    const shotPlanPath = resolve(dir, 'shot_plan.json');
    await atomicJson(shotPlanPath, shotPlan);

    // 6. Generate/resolve base assets and compose shot variations with bounded concurrency
    const limit = pLimit(Math.max(1, this.options.sceneConcurrency ?? 2));
    const compositor = new ShotCompositor(this.width, this.height);
    const assetBuffers = new Map<string, Buffer>();
    let newImageCount = 0;

    // First generate base assets for shots marked generatedByAi
    const uniqueAiShots = shotPlan.shots.filter((s) => s.generatedByAi);
    await Promise.all(
      uniqueAiShots.map((shot) =>
        limit(async () => {
          this.options.costGuard?.assertWithinBudget();
          const imgStart = Date.now();
          const baseScenePath = resolve(dir, 'assets', `${shot.assetKey ?? shot.shotId}.png`);
          if (this.sceneProvider instanceof OpenRouterSceneProvider) {
            const created = await this.sceneProvider.createWithProvenance(
              {
                sceneId: shot.shotId,
                segmentIds: shot.sourceSegmentIds,
                visualPrompt: shot.visualPrompt,
                onScreenText: shot.onScreenText,
                durationSeconds: Math.max(1, shot.endSeconds - shot.startSeconds),
                sourcePages: shot.sourcePages,
              },
              baseScenePath,
            );
            shot.provenance = created.provenance;
            if (created.provenance === 'ai') newImageCount++;
            if (created.backgroundBuffer && shot.assetKey) {
              assetBuffers.set(shot.assetKey, created.backgroundBuffer);
            }
          } else {
            await this.sceneProvider.create(
              {
                sceneId: shot.shotId,
                segmentIds: shot.sourceSegmentIds,
                visualPrompt: shot.visualPrompt,
                onScreenText: shot.onScreenText,
                durationSeconds: Math.max(1, shot.endSeconds - shot.startSeconds),
                sourcePages: shot.sourcePages,
              },
              baseScenePath,
            );
            shot.provenance = 'sharp-fallback';
          }
          this.options.reporter?.record({
            event: shot.provenance === 'cache' ? 'scene.reused' : 'image.generated',
            stage: 'image',
            chapter: chapter.number,
            durationPreset: script.durationMinutes,
            elapsedMs: Date.now() - imgStart,
            degraded: shot.provenance === 'sharp-fallback',
          });
        }),
      ),
    );

    const shotImagePaths = await Promise.all(
      shotPlan.shots.map((shot) =>
        limit(async () => {
          const outShotPng = resolve(dir, 'scenes', `${shot.shotId}.png`);
          const baseBuf = shot.assetKey ? assetBuffers.get(shot.assetKey) : undefined;
          const composedPath = await compositor.composeShot(
            shot,
            outShotPng,
            baseBuf,
            shot.variantIndex,
          );
          shot.assetPath = this.store.relative(composedPath);
          if (!shot.provenance) {
            shot.provenance = baseBuf ? 'cache' : 'sharp-fallback';
          }
          return composedPath;
        }),
      ),
    );

    await atomicJson(shotPlanPath, shotPlan);

    // 7. Render MP4 with FFmpeg
    const renderStart = Date.now();
    const renderer = new FfmpegRenderer({
      width: this.width,
      height: this.height,
      fps,
      preset,
      crf,
      burnCaptions: this.burnCaptions,
      expectedDurationSeconds: normalizedAudio.durationSeconds,
      maxDurationMismatchSeconds: Math.max(2.5, normalizedAudio.durationSeconds * 0.15),
    });

    const video = await renderer.render(
      shotPlan.shots.map((s, i) => ({
        imagePath:
          shotImagePaths[i] ??
          (() => {
            throw new Error('Asset de cena ausente');
          })(),
        durationSeconds: Math.max(0.2, s.endSeconds - s.startSeconds),
      })),
      audioPath,
      outVideoPath,
      captionsPath,
    );

    this.options.reporter?.record({
      event: 'video.rendered',
      stage: 'render',
      chapter: chapter.number,
      durationPreset: script.durationMinutes,
      elapsedMs: Date.now() - renderStart,
    });

    // 8. Verify video quality
    const allowSynthetic = this.options.allowSyntheticFixture ?? true;
    const report = await checkVideo(video, {
      width: this.width,
      height: this.height,
      expectedDurationSeconds: normalizedAudio.durationSeconds,
      maxDurationDeltaSeconds: Math.max(1.0, normalizedAudio.durationSeconds * 0.12),
      captionsPath,
      alignmentMethod: alignment.method,
      ttsDegraded,
      ttsWasSyntheticFixture,
      allowSyntheticFixture: allowSynthetic,
    });

    const allWarnings = [...new Set([...warnings, ...report.warnings])];
    const isDegraded =
      Boolean(script.degraded) ||
      ttsDegraded ||
      alignment.method !== 'forced-alignment' ||
      shotPlan.shots.some((s) => s.provenance === 'sharp-fallback');

    const manifest: VideoManifest = {
      schemaVersion: 2,
      status: report.passed ? 'completed' : 'failed',
      degraded: isDegraded,
      shotPlanPath: this.store.relative(shotPlanPath),
      videoPath: this.store.relative(video),
      captionsPath: this.store.relative(captionsPath),
      assCaptionsPath: this.store.relative(assCaptionsPath),
      alignmentPath: this.store.relative(alignmentPath),
      narrationPath: this.store.relative(audioPath),
      qualityReportPath: this.store.relative(resolve(dir, 'quality_report.json')),
      durationSeconds: report.durationSeconds,
      width: report.width,
      height: report.height,
      fps: report.fps || fps,
      shotCount: shotPlan.shots.length,
      newImageCount,
      alignmentMethod: alignment.method,
      attempts: 1,
      retryable: false,
      scriptHash,
      configHash,
      promptVersion: 'v2.0',
      warnings: allWarnings,
      errors: report.errors,
    };

    await this.store.saveManifest(chapter.number, script.durationMinutes, manifest);
    await this.store.saveJson(this.store.relative(resolve(dir, 'quality_report.json')), report);

    if (!report.passed) {
      this.options.reporter?.record({
        event: 'quality.failed',
        stage: 'quality',
        chapter: chapter.number,
        durationPreset: script.durationMinutes,
        elapsedMs: 0,
        warning: report.errors.join('; '),
      });
      throw new AppError(`Quality gate do vídeo falhou: ${report.errors.join('; ')}`, {
        code: 'VIDEO_QUALITY_FAILED',
        stage: 'quality_check',
        retryable: false,
      });
    }

    return video;
  }
}
