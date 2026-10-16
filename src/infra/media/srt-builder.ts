import { mkdir, rename, writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ApproximateAligner } from '../../application/services/approximate-aligner.js';
import {
  buildSubtitleCues,
  type SubtitleCue,
  type SubtitleCueBuilderOptions,
} from '../../application/services/subtitle-cue-builder.js';

export type TimedSpeechSegment = {
  segmentId?: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export function formatSrtTime(s: number): string {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const mil = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(mil).padStart(3, '0')}`;
}

export function formatSrt(cues: SubtitleCue[]): string {
  return cues
    .map(
      (cue, idx) =>
        `${idx + 1}\n${formatSrtTime(cue.startSeconds)} --> ${formatSrtTime(cue.endSeconds)}\n${cue.text}\n`,
    )
    .join('\n');
}

export async function writeSrt(cues: SubtitleCue[], path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, formatSrt(cues), 'utf8');
  await rename(tmp, path);
  return path;
}

export async function buildSrt(
  segments: TimedSpeechSegment[],
  path: string,
  options: SubtitleCueBuilderOptions = {},
): Promise<string> {
  const aligner = new ApproximateAligner();
  const alignment = await aligner.alignSegments(segments);
  const cues = buildSubtitleCues(alignment.words, options);
  return writeSrt(cues, path);
}

export async function parseSrtCues(path: string) {
  const content = await readFile(path, 'utf8');
  return content
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block) => {
      const l = block.split('\n');
      const m = l[1]?.match(/(\d\d):(\d\d):(\d\d),(\d\d\d) --> (\d\d):(\d\d):(\d\d),(\d\d\d)/);
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
