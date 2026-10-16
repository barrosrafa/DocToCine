import { spawn } from 'node:child_process';
import { access, rename, unlink, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildSubtitleFilterExpression, escapeConcatFilePath } from './ffmpeg-paths.js';

export type RenderOptions = {
  width: number;
  height: number;
  fps: number;
  crf?: number;
  preset?: string;
  burnCaptions?: boolean;
  normalizeAudio?: boolean;
  expectedDurationSeconds?: number;
  maxDurationMismatchSeconds?: number;
};

export type RenderScene = { imagePath: string; durationSeconds: number };

function run(cmd: string, args: string[], timeoutMs = 180000) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('Timeout na renderização de vídeo com FFmpeg.'));
    }, timeoutMs);

    p.stderr.on('data', (d) => {
      if (err.length < 128 * 1024) {
        err += String(d);
      }
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (c) => {
      clearTimeout(timer);
      if (c === 0) resolve();
      else reject(new Error(err || `FFmpeg terminou com código ${c}`));
    });
  });
}

export class FfmpegRenderer {
  readonly ffmpeg = 'ffmpeg';
  constructor(readonly options: RenderOptions) {}

  async render(scene: RenderScene[], audioPath: string, out: string, captions?: string) {
    if (scene.length === 0) {
      throw new Error('Nenhuma cena fornecida para renderização.');
    }

    const totalSceneDuration = scene.reduce((acc, s) => acc + s.durationSeconds, 0);
    if (this.options.expectedDurationSeconds !== undefined) {
      const maxMismatch = this.options.maxDurationMismatchSeconds ?? 1.5;
      const diff = Math.abs(totalSceneDuration - this.options.expectedDurationSeconds);
      if (diff > maxMismatch) {
        throw new Error(
          `Duração da timeline de cenas (${totalSceneDuration.toFixed(2)}s) diverge do áudio (${this.options.expectedDurationSeconds.toFixed(2)}s) além da tolerância (${maxMismatch}s).`,
        );
      }
    }

    await mkdir(dirname(out), { recursive: true });
    const list = `${out}.concat.txt`;

    const lines = scene
      .map(
        (s) =>
          `file '${escapeConcatFilePath(s.imagePath)}'\nduration ${Math.max(0.1, Number(s.durationSeconds.toFixed(4)))}`,
      )
      .join('\n');
    const last = scene.at(-1);
    const concatContent = last
      ? `${lines}\nfile '${escapeConcatFilePath(last.imagePath)}'\n`
      : lines + '\n';

    await writeFile(list, concatContent, 'utf8');

    const baseVf = `scale=${this.options.width}:${this.options.height},format=yuv420p`;
    const vfWithCaptions =
      this.options.burnCaptions && captions
        ? `${baseVf},${buildSubtitleFilterExpression(captions)}`
        : baseVf;

    const partial = `${out}.partial.mp4`;
    const buildArgs = (vf: string, useLoudnorm: boolean) => [
      '-hide_banner',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-i',
      audioPath,
      '-r',
      String(this.options.fps),
      '-vf',
      vf,
      '-c:v',
      'libx264',
      '-preset',
      this.options.preset ?? 'medium',
      '-crf',
      String(this.options.crf ?? 20),
      '-pix_fmt',
      'yuv420p',
      ...(useLoudnorm ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : []),
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      '-shortest',
      partial,
    ];

    try {
      const useLoudnorm = this.options.normalizeAudio ?? true;
      try {
        await run(this.ffmpeg, buildArgs(vfWithCaptions, useLoudnorm));
      } catch (firstErr) {
        // Fallback if libass/subtitles filter or loudnorm filter is not compiled into current ffmpeg binary
        if (vfWithCaptions !== baseVf || useLoudnorm) {
          await run(this.ffmpeg, buildArgs(baseVf, false)).catch(() => {
            throw firstErr;
          });
        } else {
          throw firstErr;
        }
      }
      await rename(partial, out);
    } finally {
      await unlink(list).catch(() => {});
      await unlink(partial).catch(() => {});
    }
    await access(out);
    return out;
  }
}
