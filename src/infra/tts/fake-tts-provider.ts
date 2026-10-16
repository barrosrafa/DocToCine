import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

export type Timed = { segmentId: string; text: string; startSeconds: number; endSeconds: number };

function execProcess(cmd: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += String(d)));
    p.stderr.on('data', (d) => (stderr += String(d)));
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res(stdout) : rej(new Error(stderr || `${cmd} exited ${c}`))));
  });
}

export class FakeTtsProvider {
  constructor(readonly secondsPerWord = 0.4) {}

  private async trySay(text: string, path: string): Promise<number | null> {
    if (process.platform !== 'darwin') return null;
    const aiffPath = `${path}.aiff`;
    try {
      await execProcess('say', ['-v', 'Luciana', text, '-o', aiffPath]);
      await execProcess('ffmpeg', [
        '-hide_banner',
        '-y',
        '-i',
        aiffPath,
        '-c:a',
        'libmp3lame',
        '-b:a',
        '128k',
        path,
      ]);
      await unlink(aiffPath).catch(() => {});
      const durStr = await execProcess('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        path,
      ]);
      const d = parseFloat(durStr.trim());
      if (!isNaN(d) && d > 0) return d;
      return null;
    } catch {
      await unlink(aiffPath).catch(() => {});
      return null;
    }
  }

  async synthesize(text: string, path: string): Promise<{ path: string; duration: number }> {
    if (!text.trim()) throw new Error('segmento vazio');
    await mkdir(dirname(path), { recursive: true });

    const sayDuration = await this.trySay(text, path);
    if (sayDuration !== null) {
      return { path, duration: sayDuration };
    }

    // Audible tone WAV fallback if say is unavailable
    const words = text.trim().split(/\s+/).length;
    const duration = Math.max(1.0, words * this.secondsPerWord);
    const sampleRate = 8000;
    const totalSamples = Math.round(duration * sampleRate);
    const bytes = Buffer.alloc(44 + totalSamples * 2);

    // WAV header
    bytes.write('RIFF', 0);
    bytes.writeUInt32LE(36 + totalSamples * 2, 4);
    bytes.write('WAVE', 8);
    bytes.write('fmt ', 12);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20); // PCM
    bytes.writeUInt16LE(1, 22); // Mono
    bytes.writeUInt32LE(sampleRate, 24);
    bytes.writeUInt32LE(sampleRate * 2, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36);
    bytes.writeUInt32LE(totalSamples * 2, 40);

    // Subtle 220Hz pleasant tone with fade-in and fade-out envelope
    for (let i = 0; i < totalSamples; i++) {
      const t = i / sampleRate;
      const attack = Math.min(1, i / (sampleRate * 0.1));
      const release = Math.min(1, (totalSamples - i) / (sampleRate * 0.1));
      const envelope = Math.max(0, attack * release);
      const sampleVal = Math.floor(Math.sin(2 * Math.PI * 220 * t) * 6000 * envelope);
      bytes.writeInt16LE(sampleVal, 44 + i * 2);
    }

    const wavPath = path.endsWith('.mp3') ? `${path}.wav` : path;
    await writeFile(wavPath, bytes);

    if (path.endsWith('.mp3')) {
      try {
        await execProcess('ffmpeg', [
          '-hide_banner',
          '-y',
          '-i',
          wavPath,
          '-c:a',
          'libmp3lame',
          '-b:a',
          '128k',
          path,
        ]);
        await unlink(wavPath).catch(() => {});
      } catch {
        // keep wavPath if ffmpeg fails
      }
    }

    return { path, duration };
  }

  async synthesizeSegments(
    segments: { id: string; text: string }[],
    dir: string,
  ): Promise<{ timed: Timed[]; duration: number }> {
    let cursor = 0;
    const timed: Timed[] = [];
    for (const s of segments) {
      const r = await this.synthesize(s.text, `${dir}/${s.id}.mp3`);
      timed.push({
        segmentId: s.id,
        text: s.text,
        startSeconds: cursor,
        endSeconds: cursor + r.duration,
      });
      cursor += r.duration;
    }
    return { timed, duration: cursor };
  }
}
