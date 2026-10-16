import { mkdir, rename, writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
export type TimedSpeechSegment = {
  segmentId?: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
};
function time(s: number) {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000),
    m = Math.floor((ms % 3600000) / 60000),
    sec = Math.floor((ms % 60000) / 1000),
    mil = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(mil).padStart(3, '0')}`;
}
function chunks(text: string) {
  const words = text.replace(/\x00/g, ' ').trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur: string[] = [];
  for (const w of words) {
    if (cur.length >= 8 || cur.join(' ').length + w.length + 1 > 55) {
      if (cur.length) out.push(cur.join(' '));
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
}
export async function buildSrt(segments: TimedSpeechSegment[], path: string) {
  await mkdir(dirname(path), { recursive: true });
  let last = 0;
  const cues: string[] = [];
  let n = 1;
  for (const s of segments) {
    if (!s.text.trim()) continue;
    const parts = chunks(s.text);
    const start = Math.max(last, s.startSeconds),
      duration = Math.max((s.endSeconds - s.startSeconds) / parts.length, 0.1);
    parts.forEach((p, i) => {
      const a = start + i * duration,
        b = Math.max(a + 0.05, Math.min(s.endSeconds, a + duration));
      cues.push(`${n++}\n${time(a)} --> ${time(b)}\n${p}\n`);
      last = b;
    });
  }
  const tmp = `${path}.tmp`;
  await writeFile(tmp, cues.join('\n'), 'utf8');
  await rename(tmp, path);
  return path;
}
export async function parseSrtCues(path: string) {
  const content = await readFile(path, 'utf8');
  return content
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block) => {
      const l = block.split('\n'),
        m = l[1]?.match(/(\d\d):(\d\d):(\d\d),(\d\d\d) --> (\d\d):(\d\d):(\d\d),(\d\d\d)/);
      if (!m) throw new Error('SRT inválido');
      const nums = m.slice(1).map(Number);
      const f = (h: number, mi: number, s: number, ms: number) =>
        h * 3600 + mi * 60 + s + ms / 1000;
      return [
        Number(l[0]),
        f(nums[0]!, nums[1]!, nums[2]!, nums[3]!),
        f(nums[4]!, nums[5]!, nums[6]!, nums[7]!),
        l.slice(2).join('\n'),
      ] as const;
    });
}
