import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
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

function execProcess(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(err || `${cmd} failed: ${c}`))));
  });
}

export class VideoPipeline {
  constructor(
    readonly store: ArtifactStore,
    readonly width = 1280,
    readonly height = 720,
    readonly burnCaptions = true,
  ) {}

  async render(script: VideoScript, chapter: ChapterBoundary): Promise<string> {
    const dir = this.store.videoDir(chapter.number, script.durationMinutes);
    await mkdir(resolve(dir, 'scenes'), { recursive: true });
    await mkdir(resolve(dir, 'audio'), { recursive: true });

    // 1. Generate storyboards
    const scenes = createStoryboard(script, chapter);
    const provider = new SharpSceneProvider(this.width, this.height);
    const paths: string[] = [];
    for (const s of scenes) {
      paths.push(await provider.create(s, resolve(dir, 'scenes', `${s.sceneId}.png`)));
    }

    // 2. Synthesize audio per segment
    const tts = new FakeTtsProvider();
    const audio = await tts.synthesizeSegments(script.segments, resolve(dir, 'audio'));

    // 3. Align scene durations with real speech durations
    for (let i = 0; i < scenes.length; i++) {
      const timed = audio.timed[i];
      if (timed) {
        scenes[i]!.durationSeconds = Math.max(1, timed.endSeconds - timed.startSeconds);
      }
    }

    // 4. Concatenate all segment audio files into narration.mp3
    const audioPath = resolve(dir, 'audio', 'narration.mp3');
    if (script.segments.length === 1) {
      const first = resolve(dir, 'audio', `${script.segments[0]!.id}.mp3`);
      await import('node:fs/promises').then((fs) => fs.copyFile(first, audioPath));
    } else {
      const listTxt = resolve(dir, 'audio', 'concat_audio.txt');
      const lines = script.segments
        .map((s) => `file '${resolve(dir, 'audio', `${s.id}.mp3`).replaceAll("'", "'\\''")}'`)
        .join('\n');
      await writeFile(listTxt, lines + '\n', 'utf8');
      try {
        await execProcess('ffmpeg', [
          '-hide_banner',
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listTxt,
          '-c:a',
          'libmp3lame',
          '-b:a',
          '128k',
          audioPath,
        ]);
      } catch {
        // Fallback to copy if re-encoding fails
        await execProcess('ffmpeg', [
          '-hide_banner',
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listTxt,
          '-c',
          'copy',
          audioPath,
        ]);
      } finally {
        await unlink(listTxt).catch(() => {});
      }
    }

    // 5. Build synchronized subtitles
    const captionsPath = resolve(dir, 'captions.srt');
    await buildSrt(
      audio.timed.map((t) => ({
        text: t.text,
        startSeconds: t.startSeconds,
        endSeconds: t.endSeconds,
      })),
      captionsPath,
    );

    // 6. Render MP4 with FFmpeg
    const renderer = new FfmpegRenderer({
      width: this.width,
      height: this.height,
      fps: 30,
      preset: 'ultrafast',
      crf: 22,
      burnCaptions: this.burnCaptions,
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
      captionsPath,
    );

    // 7. Verify video quality
    const report = await checkVideo(video, { width: this.width, height: this.height });
    const manifest: VideoManifest = {
      status: report.passed ? 'completed' : 'failed',
      videoPath: this.store.relative(video),
      captionsPath: this.store.relative(captionsPath),
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
