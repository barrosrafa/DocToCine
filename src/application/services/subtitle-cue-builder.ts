import type { WordTiming } from '../../domain/schemas/alignment.schema.js';

export type SubtitleCue = {
  id: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
  words: string[];
};

export type SubtitleCueBuilderOptions = {
  maxWordsPerCue?: number;
  maxCharsPerLine?: number;
  maxLines?: number;
  minCueSeconds?: number;
  maxCueSeconds?: number;
  aspectRatio?: '16:9' | '9:16';
};

function wrapCueLines(words: string[], maxCharsPerLine: number, maxLines: number): string {
  const full = words.join(' ').trim();
  if (full.length <= maxCharsPerLine || maxLines <= 1 || words.length <= 1) {
    return full;
  }

  // Balance two lines as evenly as possible without breaking words
  let bestSplit = Math.ceil(words.length / 2);
  let bestDiff = Number.POSITIVE_INFINITY;

  for (let i = 1; i < words.length; i++) {
    const left = words.slice(0, i).join(' ');
    const right = words.slice(i).join(' ');
    if (left.length <= maxCharsPerLine && right.length <= maxCharsPerLine) {
      const diff = Math.abs(left.length - right.length);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestSplit = i;
      }
    }
  }

  const line1 = words.slice(0, bestSplit).join(' ');
  const line2 = words.slice(bestSplit).join(' ');
  return `${line1}\n${line2}`;
}

function endsClauseOrSentence(word: string): boolean {
  return /[.!?…,;:)”"']$/.test(word);
}

function endsSentence(word: string): boolean {
  return /[.!?…][”"']*$/.test(word);
}

export function buildSubtitleCues(
  words: WordTiming[],
  options: SubtitleCueBuilderOptions = {},
): SubtitleCue[] {
  if (words.length === 0) return [];

  const isVertical = options.aspectRatio === '9:16';
  const maxWordsPerCue = options.maxWordsPerCue ?? (isVertical ? 5 : 7);
  const maxCharsPerLine = options.maxCharsPerLine ?? (isVertical ? 28 : 38);
  const maxLines = options.maxLines ?? 2;
  const maxTotalChars = maxCharsPerLine * maxLines;
  const minCueSeconds = options.minCueSeconds ?? 0.8;
  const maxCueSeconds = options.maxCueSeconds ?? 4.8;

  const sortedWords = [...words].sort((a, b) => a.startSeconds - b.startSeconds);
  const cues: SubtitleCue[] = [];
  let current: WordTiming[] = [];
  let lastEndSeconds = 0;

  const flush = (batch: WordTiming[]) => {
    if (batch.length === 0) return;
    const first = batch[0]!;
    const last = batch.at(-1)!;
    const startSeconds = Number(Math.max(lastEndSeconds, first.startSeconds).toFixed(3));
    const endSeconds = Number(Math.max(startSeconds + 0.08, last.endSeconds).toFixed(3));
    const wordStrings = batch.map((w) => w.text);
    const text = wrapCueLines(wordStrings, maxCharsPerLine, maxLines);

    cues.push({
      id: cues.length + 1,
      startSeconds,
      endSeconds,
      text,
      words: wordStrings,
    });
    lastEndSeconds = endSeconds;
  };

  for (const word of sortedWords) {
    if (current.length === 0) {
      current.push(word);
      continue;
    }

    const candidate = [...current, word];
    const candidateText = candidate.map((w) => w.text).join(' ');
    const currentDur = current.at(-1)!.endSeconds - current[0]!.startSeconds;
    const candidateDur = word.endSeconds - current[0]!.startSeconds;
    const lastWordText = current.at(-1)!.text;

    const exceedsWords = candidate.length > maxWordsPerCue;
    const exceedsChars = candidateText.length > maxTotalChars;
    const exceedsMaxDuration = candidateDur > maxCueSeconds;
    const naturalSentenceBreak = endsSentence(lastWordText) && currentDur >= minCueSeconds;
    const naturalClauseBreak =
      endsClauseOrSentence(lastWordText) && current.length >= 4 && currentDur >= minCueSeconds;

    if (
      exceedsWords ||
      exceedsChars ||
      exceedsMaxDuration ||
      naturalSentenceBreak ||
      naturalClauseBreak
    ) {
      flush(current);
      current = [word];
    } else {
      current = candidate;
    }
  }

  flush(current);
  return cues;
}
