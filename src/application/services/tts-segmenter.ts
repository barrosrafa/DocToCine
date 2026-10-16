import { createHash } from 'node:crypto';
import { preprocessNarrationText, type PronunciationDictionary } from './narration-preprocessor.js';

export type TtsNarrationUnit = {
  unitId: string;
  unitIndex: number;
  parentSegmentId: string;
  editorialText: string;
  spokenText: string;
  sourcePages: number[];
  idempotencyKey: string;
};

export type TtsSegmenterOptions = {
  maxCharsPerRequest?: number;
  model?: string;
  voice?: string;
  speed?: number;
  styleInstructions?: string;
  dictionary?: Partial<PronunciationDictionary>;
};

const PROVIDER_VERSION = 'v2.0';

function splitIntoSentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [text.trim()].filter(Boolean);
}

function splitLongSentenceByWords(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence];
  const words = sentence.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && candidate.length > maxChars) {
      chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function computeTtsIdempotencyKey(params: {
  spokenText: string;
  model: string;
  voice: string;
  speed: number;
  styleInstructions?: string;
}): string {
  const canonical = JSON.stringify({
    providerVersion: PROVIDER_VERSION,
    model: params.model,
    voice: params.voice,
    speed: Number(params.speed.toFixed(3)),
    styleInstructions: params.styleInstructions ?? '',
    spokenText: params.spokenText,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function segmentNarrationForTts(
  segments: { id: string; text: string; sourcePages?: number[] }[],
  options: TtsSegmenterOptions = {},
): TtsNarrationUnit[] {
  const maxChars = Math.max(100, options.maxCharsPerRequest ?? 1800);
  const model = options.model ?? 'openai/gpt-4o-mini-tts-2025-12-15';
  const voice = options.voice ?? 'nova';
  const speed = options.speed ?? 1.0;

  const units: TtsNarrationUnit[] = [];

  for (const seg of segments) {
    const rawParagraphs = seg.text
      .split(/\n\s*\n+/)
      .map((p) => p.trim())
      .filter(Boolean);

    const sentences: string[] = [];
    for (const para of rawParagraphs) {
      for (const s of splitIntoSentences(para)) {
        sentences.push(...splitLongSentenceByWords(s, maxChars));
      }
    }

    let curEditorial: string[] = [];
    let curSpoken: string[] = [];

    const flush = () => {
      if (curEditorial.length === 0) return;
      const editorialText = curEditorial.join(' ').trim();
      const spokenText = curSpoken.join(' ').trim();
      if (!spokenText) return;

      const unitIndex = units.length;
      const unitId = `${seg.id}_u${String(unitIndex + 1).padStart(3, '0')}`;
      const idempotencyKey = computeTtsIdempotencyKey({
        spokenText,
        model,
        voice,
        speed,
        ...(options.styleInstructions !== undefined
          ? { styleInstructions: options.styleInstructions }
          : {}),
      });

      units.push({
        unitId,
        unitIndex,
        parentSegmentId: seg.id,
        editorialText,
        spokenText,
        sourcePages: seg.sourcePages ?? [],
        idempotencyKey,
      });

      curEditorial = [];
      curSpoken = [];
    };

    for (const sentence of sentences) {
      const processed = preprocessNarrationText(sentence, options.dictionary);
      const candidateSpoken = [...curSpoken, processed.spokenText].join(' ');
      if (curSpoken.length > 0 && candidateSpoken.length > maxChars) {
        flush();
      }
      curEditorial.push(processed.editorialText);
      curSpoken.push(processed.spokenText);
    }
    flush();
  }

  return units;
}
