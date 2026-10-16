#!/usr/bin/env node
import { resolve } from 'node:path';
import { buildCli } from './cli/build-cli.js';
import { ArtifactStore } from './infra/storage/artifact-store.js';
import { BookPipeline } from './application/pipelines/book-pipeline.js';
import { VideoPipeline } from './application/pipelines/video-pipeline.js';
import { OpenRouterLlmProvider } from './infra/llm/openrouter-provider.js';
import { OpenRouterSpeechProvider } from './infra/tts/openrouter-speech-provider.js';
import { FallbackTtsProvider } from './infra/tts/fallback-tts-provider.js';
import { FakeTtsProvider } from './infra/tts/fake-tts-provider.js';
import { OpenRouterSceneProvider } from './infra/media/openrouter-scene-provider.js';
import { SharpSceneProvider } from './infra/media/sharp-scene-provider.js';
import { SceneCache } from './infra/storage/scene-cache.js';
import { ApproximateAligner } from './application/services/approximate-aligner.js';
import { WhisperXAligner } from './infra/alignment/whisperx-aligner.js';
import { CostGuard } from './application/services/cost-guard.js';
import { JobReporter } from './application/services/job-reporter.js';
import { loadSettings } from './config/settings.js';
import { AppError, asError } from './core/errors/app-error.js';
import type { TtsProvider } from './domain/ports/tts-provider.js';
import type { AlignmentProvider } from './domain/ports/alignment-provider.js';
import type { SceneAssetProvider } from './domain/ports/scene-provider.js';

export async function run(argv = process.argv): Promise<number> {
  const cli = buildCli();
  cli.parse(argv);
  const opts = cli.opts<{
    output: string;
    chapters: string;
    durations: string;
    renderVideos?: boolean;
    aspectRatio?: '16:9' | '9:16';
    visualMode?: 'economic' | 'balanced' | 'dynamic';
    voice?: string;
    burnCaptions?: boolean;
    maxCostUsd?: string;
    resume?: boolean;
    force?: boolean;
    continueOnError?: boolean;
    verbose?: boolean;
  }>();

  const pdf = cli.args[0];
  if (!pdf) {
    console.error('lcbooks: informe o caminho do arquivo PDF como primeiro argumento.');
    return 1;
  }

  try {
    const settings = loadSettings();
    const output = resolve(opts.output);
    const store = new ArtifactStore(output);

    // Duração dos roteiros (1, 3, 20 minutos)
    const durations = opts.durations
      .split(',')
      .map(Number)
      .filter((d): d is 1 | 3 | 20 => d === 1 || d === 3 || d === 20);
    if (!durations.length) {
      throw new AppError('Informe ao menos uma duração válida: 1, 3 ou 20.', {
        code: 'INVALID_INPUT',
        stage: 'configuration',
      });
    }

    const secrets = [settings.OPENROUTER_API_KEY].filter((s): s is string => Boolean(s));
    const jobId = `job_${Date.now()}`;
    const reporter = new JobReporter(jobId, secrets, Boolean(opts.verbose));

    // Limite de orçamento & governança
    const maxCost =
      opts.maxCostUsd !== undefined ? Number(opts.maxCostUsd) : settings.MAX_JOB_COST_USD;
    const costGuard = new CostGuard({
      jobId,
      maxCostUsd: maxCost,
      action: settings.COST_LIMIT_ACTION,
    });

    // Proporção de vídeo (16:9 widescreen vs 9:16 vertical)
    const aspectRatio = opts.aspectRatio ?? '16:9';
    const [width, height] =
      aspectRatio === '9:16'
        ? [settings.VIDEO_HEIGHT, settings.VIDEO_WIDTH]
        : [settings.VIDEO_WIDTH, settings.VIDEO_HEIGHT];

    const apiKey = settings.OPENROUTER_API_KEY;
    const isProductionRender = Boolean(opts.renderVideos);

    // Cache de cenas visuais
    const sceneCache = settings.SCENE_CACHE_ENABLED
      ? new SceneCache(resolve(store.baseDir, 'cache', 'scenes'))
      : undefined;

    // Provedor de Cenas Visuais
    const visualMode = opts.visualMode ?? 'balanced';
    let sceneProvider: SceneAssetProvider;
    if (settings.SCENE_PROVIDER === 'openrouter' && apiKey) {
      sceneProvider = new OpenRouterSceneProvider({
        apiKey,
        baseUrl: settings.OPENROUTER_BASE_URL,
        model: settings.OPENROUTER_IMAGE_MODEL,
        width,
        height,
        timeoutMs: settings.OPENROUTER_TIMEOUT_MS,
        ...(sceneCache ? { sceneCache } : {}),
        onUsage: (u) => {
          costGuard.recordUsage({
            jobId,
            stage: 'assets',
            model: u.model,
            estimatedCostUsd: u.cached || u.fallback ? 0 : 0.04,
            costStatus: 'estimated',
            elapsedMs: u.elapsedMs,
            fallback: u.fallback,
          });
          reporter.record({
            event: u.cached ? 'scene.reused' : 'image.generated',
            stage: 'assets',
            usedModel: u.model,
            elapsedMs: u.elapsedMs,
          });
        },
      });
    } else {
      sceneProvider = new SharpSceneProvider(width, height);
    }

    // Provedor de TTS (Síntese de Voz Real pt-BR ou fallback)
    const voice = opts.voice ?? settings.TTS_VOICE;
    let ttsProvider: TtsProvider;

    if (
      (settings.TTS_PROVIDER === 'openrouter' || settings.TTS_PROVIDER === 'openrouter-speech') &&
      apiKey
    ) {
      const primaryTts = new OpenRouterSpeechProvider({
        apiKey,
        baseUrl: settings.OPENROUTER_BASE_URL,
        model: settings.OPENROUTER_TTS_MODEL,
        voice,
        speed: settings.OPENROUTER_TTS_SPEED,
        timeoutMs: settings.OPENROUTER_TIMEOUT_MS,
        maxRetries: settings.MAX_RETRY_ATTEMPTS,
        maxParallelRequests: settings.TTS_MAX_PARALLEL_REQUESTS,
        onUsage: (u) => {
          const estimated = (u.inputCharacters / 1000) * 0.015;
          costGuard.recordUsage({
            jobId,
            stage: 'audio',
            model: u.model,
            inputCharacters: u.inputCharacters,
            outputBytes: u.outputBytes,
            estimatedCostUsd: estimated,
            costStatus: 'estimated',
            elapsedMs: u.elapsedMs,
          });
          reporter.record({
            event: 'tts.completed',
            stage: 'audio',
            usedModel: u.model,
            elapsedMs: u.elapsedMs,
            bytes: u.outputBytes,
          });
        },
      });

      if (settings.OPENROUTER_TTS_FALLBACK_MODEL) {
        const secondaryTts = new OpenRouterSpeechProvider({
          apiKey,
          baseUrl: settings.OPENROUTER_BASE_URL,
          model: settings.OPENROUTER_TTS_FALLBACK_MODEL,
          voice: settings.OPENROUTER_TTS_FALLBACK_VOICE ?? voice,
          speed: settings.OPENROUTER_TTS_SPEED,
          timeoutMs: settings.OPENROUTER_TIMEOUT_MS,
          maxRetries: settings.MAX_RETRY_ATTEMPTS,
          maxParallelRequests: settings.TTS_MAX_PARALLEL_REQUESTS,
          onUsage: (u) => {
            const estimated = (u.inputCharacters / 1000) * 0.015;
            costGuard.recordUsage({
              jobId,
              stage: 'audio',
              model: u.model,
              inputCharacters: u.inputCharacters,
              outputBytes: u.outputBytes,
              estimatedCostUsd: estimated,
              costStatus: 'estimated',
              elapsedMs: u.elapsedMs,
              fallback: true,
            });
            reporter.record({
              event: 'tts.completed',
              stage: 'audio',
              usedModel: u.model,
              elapsedMs: u.elapsedMs,
              bytes: u.outputBytes,
            });
          },
        });
        ttsProvider = new FallbackTtsProvider(primaryTts, secondaryTts);
      } else {
        ttsProvider = primaryTts;
      }
    } else {
      if (isProductionRender && !settings.TTS_ALLOW_SYNTHETIC_FIXTURE) {
        throw new AppError(
          'Renderização de vídeo solicitada (--render-videos), mas provedor de TTS real não está configurado ' +
            '(TTS_PROVIDER=openrouter e OPENROUTER_API_KEY preenchida). ' +
            'Defina TTS_ALLOW_SYNTHETIC_FIXTURE=true se desejar gerar áudio sintético silencioso/beeps para testes locais.',
          {
            code: 'TTS_UNAVAILABLE',
            stage: 'configuration',
          },
        );
      }
      ttsProvider = new FakeTtsProvider();
    }

    // Provedor de Alinhamento Temporal de Legendas
    const approxAligner = new ApproximateAligner();
    let aligner: AlignmentProvider = approxAligner;
    if (settings.ENABLE_WORD_ALIGNMENT && settings.ALIGNMENT_PROVIDER === 'whisperx') {
      aligner = new WhisperXAligner({
        fallbackToApproximate: true,
      });
    }

    const burnCaptions = opts.burnCaptions ?? settings.BURN_CAPTIONS;
    const resume = opts.force ? false : (opts.resume ?? true);

    const videoPipeline = new VideoPipeline(
      store,
      width,
      height,
      burnCaptions,
      sceneProvider,
      ttsProvider,
      {
        fps: settings.VIDEO_FPS,
        crf: settings.VIDEO_CRF,
        preset: settings.VIDEO_PRESET,
        sceneConcurrency: settings.SCENE_CONCURRENCY,
        visualShotTargetSeconds: settings.VISUAL_SHOT_TARGET_SECONDS,
        aiImageMinIntervalSeconds: settings.AI_IMAGE_MIN_INTERVAL_SECONDS,
        maxGeneratedImagesPerVideo: settings.MAX_GENERATED_IMAGES_PER_VIDEO,
        visualMode,
        enableWordAlignment: settings.ENABLE_WORD_ALIGNMENT,
        alignmentProvider: settings.ALIGNMENT_PROVIDER,
        aligner,
        captionFontName: settings.CAPTION_FONT_NAME,
        allowSyntheticFixture: settings.TTS_ALLOW_SYNTHETIC_FIXTURE,
        resume,
        force: Boolean(opts.force),
        reporter,
        costGuard,
      },
    );

    // Provedor de LLM com fallback serializado e rastreamento de custos
    const llm = apiKey
      ? new OpenRouterLlmProvider({
          apiKey,
          baseUrl: settings.OPENROUTER_BASE_URL,
          appUrl: settings.OPENROUTER_APP_URL,
          appTitle: settings.OPENROUTER_APP_TITLE,
          summaryModel: settings.OPENROUTER_SUMMARY_MODEL,
          scriptModel: settings.OPENROUTER_SCRIPT_MODEL,
          storyboardModel: settings.OPENROUTER_STORYBOARD_MODEL,
          fallbackModels: settings.OPENROUTER_FALLBACK_MODELS,
          timeoutMs: settings.OPENROUTER_TIMEOUT_MS,
          maxRetries: settings.MAX_RETRY_ATTEMPTS,
          onUsage: (u) => {
            costGuard.recordUsage({
              jobId,
              stage: 'llm',
              model: u.model,
              promptTokens: u.usage?.promptTokens,
              completionTokens: u.usage?.completionTokens,
              estimatedCostUsd: u.usage?.estimatedCostUsd,
              costStatus: u.usage?.estimatedCostUsd !== undefined ? 'estimated' : 'unknown',
              elapsedMs: u.elapsedMs,
              fallback: u.fallback,
            });
            reporter.record({
              event: 'script.completed',
              stage: 'llm',
              requestedModel: u.requestedModel,
              usedModel: u.model,
              elapsedMs: u.elapsedMs,
            });
          },
        })
      : undefined;

    const bookPipeline = new BookPipeline(
      store,
      videoPipeline,
      llm,
      settings.LLM_CONCURRENCY,
      settings.MAX_CHAPTER_CHARS_PER_CHUNK,
    );

    const chaptersCount =
      opts.chapters === 'all' || opts.chapters === '-1' ? -1 : Number(opts.chapters);

    const result = await bookPipeline.run(
      resolve(pdf),
      chaptersCount,
      durations,
      isProductionRender,
      {
        resume,
        force: Boolean(opts.force),
        continueOnError: Boolean(opts.continueOnError),
        maxPdfMb: settings.MAX_PDF_MB,
        maxPdfPages: settings.MAX_PDF_PAGES,
        chunkOverlapChars: settings.CHAPTER_CHUNK_OVERLAP_CHARS,
        targetWpm: settings.TARGET_WORDS_PER_MINUTE,
        tolerancePercent: settings.SCRIPT_DURATION_TOLERANCE_PERCENT,
        costGuard,
        reporter,
      },
    );

    reporter.record({
      event: result.failedArtifacts.length === 0 ? 'job.completed' : 'quality.failed',
      stage: 'general',
      elapsedMs: 0,
    });

    const totalCostUsd = costGuard.totalKnownCostUsd;
    console.log(
      JSON.stringify(
        {
          output,
          chapters: result.packages.length,
          videos: result.videoPaths.length,
          failed: result.failedArtifacts,
          degraded: result.degraded,
          warnings: result.warnings,
          totalCostUsd,
        },
        null,
        2,
      ),
    );

    return result.failedArtifacts.length > 0 ? 2 : 0;
  } catch (error: unknown) {
    const err = asError(error);
    console.error(`lcbooks: ${err.message}`);

    if (error instanceof AppError) {
      if (error.code === 'BUDGET_EXCEEDED') {
        return 3;
      }
      if (error.code === 'VIDEO_QUALITY_FAILED') {
        return 4;
      }
    }
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((code) => {
    process.exitCode = code;
  });
}
