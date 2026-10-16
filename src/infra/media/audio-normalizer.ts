import { copyFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { probeAudioFile } from '../tts/audio-probe.js';

function execFfmpeg(args: string[], timeoutMs = 60000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Timeout na normalização/concatenação de áudio com ffmpeg.'));
    }, timeoutMs);

    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr || `ffmpeg retornou código ${code}`));
    });
  });
}

export type AudioNormalizerOptions = {
  normalizeLoudness?: boolean;
  sampleRate?: number;
};

export async function concatenateAndNormalizeAudio(
  segmentPaths: string[],
  outputPath: string,
  options: AudioNormalizerOptions = {},
): Promise<{ path: string; durationSeconds: number }> {
  if (segmentPaths.length === 0) {
    throw new Error('Nenhum arquivo de segmento fornecido para concatenação de áudio.');
  }

  await mkdir(dirname(outputPath), { recursive: true });
  const normalizeLoudness = options.normalizeLoudness ?? true;
  const sampleRate = options.sampleRate ?? 48000;
  const partialPath = `${outputPath}.partial.mp3`;
  const listPath = `${outputPath}.concat.txt`;

  try {
    if (segmentPaths.length === 1 && !normalizeLoudness) {
      await copyFile(segmentPaths[0]!, partialPath);
    } else {
      const concatContent =
        segmentPaths.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join('\n') + '\n';
      await writeFile(listPath, concatContent, 'utf8');

      const args = [
        '-hide_banner',
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        ...(normalizeLoudness ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : []),
        '-ar',
        String(sampleRate),
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        partialPath,
      ];

      try {
        await execFfmpeg(args);
      } catch {
        // Fallback sem filtro loudnorm caso build do ffmpeg não suporte
        await execFfmpeg([
          '-hide_banner',
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listPath,
          '-c:a',
          'libmp3lame',
          '-b:a',
          '128k',
          partialPath,
        ]);
      }
    }

    const probe = await probeAudioFile(partialPath, { minBytes: 128 });
    await rename(partialPath, outputPath);
    return {
      path: outputPath,
      durationSeconds: probe.durationSeconds,
    };
  } finally {
    await unlink(listPath).catch(() => {});
    await unlink(partialPath).catch(() => {});
  }
}
