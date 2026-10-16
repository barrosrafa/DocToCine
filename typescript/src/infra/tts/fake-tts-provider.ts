import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
export type Timed = { segmentId: string; text: string; startSeconds: number; endSeconds: number };
export class FakeTtsProvider {
  constructor(readonly secondsPerWord = 0.12) {}
  async synthesize(text: string, path: string) {
    if (!text.trim()) throw new Error('segmento vazio');
    await mkdir(dirname(path), { recursive: true });
    const duration = Math.max(0.2, text.trim().split(/\s+/).length * this.secondsPerWord);
    const samples = Math.max(8000, Math.round(duration * 8000));
    const bytes = Buffer.alloc(44 + samples * 2);
    bytes.write('RIFF', 0);
    bytes.writeUInt32LE(36 + samples * 2, 4);
    bytes.write('WAVE', 8);
    bytes.write('fmt ', 12);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(8000, 24);
    bytes.writeUInt32LE(16000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36);
    bytes.writeUInt32LE(samples * 2, 40);
    await writeFile(path, bytes);
    return { path, duration };
  }
  async synthesizeSegments(segments: { id: string; text: string }[], dir: string) {
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
