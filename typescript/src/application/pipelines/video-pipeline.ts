import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ChapterBoundary } from '../../domain/schemas/chapter.schema.js';
import type { VideoScript } from '../../domain/schemas/script.schema.js';
import { ArtifactStore } from '../../infra/storage/artifact-store.js';
import { createStoryboard } from '../services/storyboard-generator.js';
import { SharpSceneProvider } from '../../infra/media/sharp-scene-provider.js';
import { FakeTtsProvider } from '../../infra/tts/fake-tts-provider.js';
import { buildSrt } from '../../infra/media/srt-builder.js';
import { FfmpegRenderer } from '../../infra/media/ffmpeg-renderer.js';
import { checkVideo } from '../../infra/media/video-quality-checker.js';
import { type VideoManifest } from '../../domain/schemas/video.schema.js';
export class VideoPipeline {
  constructor(
    readonly store: ArtifactStore,
    readonly width = 320,
    readonly height = 180,
  ) {}
  async render(script: VideoScript, chapter: ChapterBoundary): Promise<string> {
    const dir = this.store.videoDir(chapter.number, script.durationMinutes);
    await mkdir(resolve(dir, 'scenes'), { recursive: true });
    const scenes = createStoryboard(script, chapter);
    const provider = new SharpSceneProvider(this.width, this.height);
    const paths: string[] = [];
    for (const s of scenes)
      paths.push(await provider.create(s, resolve(dir, 'scenes', `${s.sceneId}.png`)));
    const tts = new FakeTtsProvider();
    const audio = await tts.synthesizeSegments(script.segments, resolve(dir, 'audio'));
    const audioPath = resolve(dir, 'audio', 'narration.mp3');
    const concat = resolve(dir, 'audio', 'seg_0001.mp3');
    await import('node:fs/promises').then((fs) => fs.copyFile(concat, audioPath));
    await buildSrt(
      audio.timed.map((t) => ({
        text: t.text,
        startSeconds: t.startSeconds,
        endSeconds: t.endSeconds,
      })),
      resolve(dir, 'captions.srt'),
    );
    const renderer = new FfmpegRenderer({
      width: this.width,
      height: this.height,
      fps: 15,
      preset: 'ultrafast',
      crf: 28,
    });
    const video = await renderer.render(
      scenes.map((s, i) => ({
        imagePath:
          paths[i] ??
          (() => {
            throw new Error('Asset de cena ausente');
          })(),
        durationSeconds: s.durationSeconds,
      })),
      audioPath,
      resolve(dir, 'video.mp4'),
    );
    const report = await checkVideo(video, { width: this.width, height: this.height });
    const manifest: VideoManifest = {
      status: report.passed ? 'completed' : 'failed',
      videoPath: this.store.relative(video),
      captionsPath: this.store.relative(resolve(dir, 'captions.srt')),
      narrationPath: this.store.relative(audioPath),
      qualityReportPath: this.store.relative(resolve(dir, 'quality_report.json')),
      durationSeconds: report.durationSeconds,
      width: report.width,
      height: report.height,
      attempts: 1,
      retryable: false,
    };
    await this.store.saveManifest(chapter.number, script.durationMinutes, manifest);
    await this.store.saveJson(this.store.relative(resolve(dir, 'quality_report.json')), report);
    return video;
  }
}
