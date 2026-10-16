import { spawn } from 'node:child_process';
import { access, rename, unlink, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type RenderOptions = {
  width: number;
  height: number;
  fps: number;
  crf?: number;
  preset?: string;
  burnCaptions?: boolean;
};

export type RenderScene = { imagePath: string; durationSeconds: number };

function run(cmd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => {
      err += String(d);
    });
    p.on('error', reject);
    p.on('close', (c) =>
      c === 0 ? resolve() : reject(new Error(err || `FFmpeg terminou com código ${c}`)),
    );
  });
}

export class FfmpegRenderer {
  readonly ffmpeg = 'ffmpeg';
  constructor(readonly options: RenderOptions) {}

  async render(scene: RenderScene[], audioPath: string, out: string, captions?: string) {
    await mkdir(dirname(out), { recursive: true });
    const list = `${out}.concat.txt`;

    const lines = scene
      .map((s) => `file '${s.imagePath.replaceAll("'", "'\\''")}'\nduration ${s.durationSeconds}`)
      .join('\n');
    const last = scene.at(-1);
    const concatContent = last
      ? `${lines}\nfile '${last.imagePath.replaceAll("'", "'\\''")}'\n`
      : lines + '\n';

    await writeFile(list, concatContent, 'utf8');

    let vf = `scale=${this.options.width}:${this.options.height},format=yuv420p`;
    if (this.options.burnCaptions && captions) {
      vf += `,subtitles='${captions.replaceAll("'", "\\'")}'`;
    }

    const partial = `${out}.partial.mp4`;
    const args = [
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
      '-shortest',
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
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      partial,
    ];

    try {
      await run(this.ffmpeg, args);
      await rename(partial, out);
    } finally {
      await unlink(list).catch(() => {});
      await unlink(partial).catch(() => {});
    }
    await access(out);
    return out;
  }
}
