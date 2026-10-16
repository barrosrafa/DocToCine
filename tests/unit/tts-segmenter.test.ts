import { describe, expect, it } from 'vitest';
import { segmentNarrationForTts } from '../../src/application/services/tts-segmenter.js';
import { preprocessNarrationText } from '../../src/application/services/narration-preprocessor.js';

describe('TtsSegmenter & NarrationPreprocessor (Fase 4 / Sprint D)', () => {
  it('normaliza abreviaturas e siglas apenas no texto falado preservando o texto editorial original', () => {
    const original =
      'No cap. 2 (pág. 14), o Dr. Álvaro analisa o arquivo PDF com IA no século XXI.';
    const processed = preprocessNarrationText(original);

    expect(processed.editorialText).toBe(original);
    expect(processed.spokenText).toContain('capítulo 2');
    expect(processed.spokenText).toContain('página 14');
    expect(processed.spokenText).toContain('Doutor Álvaro');
    expect(processed.spokenText).toContain('século vinte e um');
  });

  it('divide segmentos longos em fronteiras de sentença sem cortar palavras ao meio e gera idempotencyKey estável', () => {
    const longSentence1 =
      'A primeira sentença descreve a chegada dos viajantes à cidade costeira durante o inverno rigoroso.';
    const longSentence2 =
      'A segunda sentença explica como os manuscritos foram guardados na torre do farol por três décadas.';
    const longSentence3 =
      'A terceira sentença revela o conteúdo da carta selada que alterou o destino da família.';

    const units = segmentNarrationForTts(
      [
        {
          id: 'seg_0001',
          text: `${longSentence1} ${longSentence2} ${longSentence3}`,
          sourcePages: [1, 2],
        },
      ],
      {
        maxCharsPerRequest: 210,
        model: 'openai/gpt-4o-mini-tts-2025-12-15',
        voice: 'nova',
        speed: 1.0,
      },
    );

    expect(units.length).toBeGreaterThanOrEqual(2);
    expect(units.every((u) => u.spokenText.length <= 210)).toBe(true);
    expect(units.map((u) => u.unitIndex)).toEqual(units.map((_, i) => i));
    expect(units[0]?.parentSegmentId).toBe('seg_0001');
    expect(units[0]?.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);

    // Mesma entrada gera exatamente a mesma idempotencyKey
    const unitsAgain = segmentNarrationForTts(
      [
        {
          id: 'seg_0001',
          text: `${longSentence1} ${longSentence2} ${longSentence3}`,
          sourcePages: [1, 2],
        },
      ],
      {
        maxCharsPerRequest: 210,
        model: 'openai/gpt-4o-mini-tts-2025-12-15',
        voice: 'nova',
        speed: 1.0,
      },
    );
    expect(unitsAgain[0]?.idempotencyKey).toBe(units[0]?.idempotencyKey);
  });
});
