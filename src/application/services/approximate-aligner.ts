import {
  AlignmentResultSchema,
  type AlignmentResult,
  type WordTiming,
} from '../../domain/schemas/alignment.schema.js';
import type {
  AlignmentProvider,
  AlignSegmentInput,
} from '../../domain/ports/alignment-provider.js';
import { probeAudioFile } from '../../infra/tts/audio-probe.js';

function estimateSyllableWeight(word: string): number {
  const clean = word.replace(/[^a-zA-ZÀ-ÿ0-9]/g, '');
  if (!clean) return 1;
  // Count vowel groups in Portuguese as syllable proxy
  const vowelGroups = clean.match(/[aeiouáéíóúâêôãõàü]+/gi);
  const syllables = vowelGroups ? vowelGroups.length : Math.ceil(clean.length / 3);
  const charBonus = clean.length * 0.22;

  let pauseWeight = 0;
  if (/[.!?…]["'”)]*$/.test(word)) {
    pauseWeight = 1.1;
  } else if (/[,;:—–]["'”)]*$/.test(word)) {
    pauseWeight = 0.45;
  }

  return Math.max(0.8, syllables + charBonus + pauseWeight);
}

export class ApproximateAligner implements AlignmentProvider {
  async alignSegments(segments: AlignSegmentInput[]): Promise<AlignmentResult> {
    const words: WordTiming[] = [];
    let globalCursor = 0;

    for (const seg of segments) {
      const tokens = seg.text.replace(/\x00/g, ' ').trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;

      const segStart = Math.max(globalCursor, seg.startSeconds);
      const segEnd = Math.max(segStart + tokens.length * 0.05, seg.endSeconds);
      const totalSegDuration = segEnd - segStart;

      const weights = tokens.map(estimateSyllableWeight);
      const totalWeight = weights.reduce((acc, w) => acc + w, 0) || tokens.length;

      let cursor = segStart;
      for (let i = 0; i < tokens.length; i++) {
        const w = tokens[i]!;
        const weight = weights[i]!;
        const rawDur = (weight / totalWeight) * totalSegDuration;
        const isLast = i === tokens.length - 1;
        const pauseGap =
          !isLast && /[.!?…]$/.test(w)
            ? Math.min(0.06, rawDur * 0.12)
            : !isLast && /[,;:]$/.test(w)
              ? Math.min(0.03, rawDur * 0.08)
              : 0;

        const startSeconds = Number(cursor.toFixed(4));
        const endRaw = isLast
          ? segEnd
          : Math.min(segEnd, cursor + Math.max(0.04, rawDur - pauseGap));
        const endSeconds = Number(Math.max(startSeconds + 0.02, endRaw).toFixed(4));

        words.push({
          text: w,
          startSeconds,
          endSeconds,
          confidence: 0.6,
          ...(seg.segmentId !== undefined ? { segmentId: seg.segmentId } : {}),
        });

        cursor = Math.min(segEnd, endSeconds + pauseGap);
      }
      globalCursor = Math.max(globalCursor, words.at(-1)?.endSeconds ?? segEnd);
    }

    return AlignmentResultSchema.parse({
      words,
      method: 'phrase-estimate',
      warnings: [
        'Alinhamento temporal estimado por ponderação fonética/silábica e pontuação (phrase-estimate).',
      ],
    });
  }

  async align(input: {
    audioPath: string;
    transcript: string;
    language: 'pt';
    durationSeconds?: number;
  }): Promise<AlignmentResult> {
    let duration = input.durationSeconds;
    if (!duration || duration <= 0) {
      try {
        const probed = await probeAudioFile(input.audioPath);
        duration = probed.durationSeconds;
      } catch {
        const wordCount = input.transcript.trim().split(/\s+/).filter(Boolean).length;
        duration = Math.max(1.0, wordCount * 0.42);
      }
    }
    return this.alignSegments([
      {
        segmentId: 'seg_full',
        text: input.transcript,
        startSeconds: 0,
        endSeconds: duration,
      },
    ]);
  }
}
