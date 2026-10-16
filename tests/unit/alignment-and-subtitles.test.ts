import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApproximateAligner } from '../../src/application/services/approximate-aligner.js';
import { buildSubtitleCues } from '../../src/application/services/subtitle-cue-builder.js';
import { buildSrt, parseSrtCues, writeSrt } from '../../src/infra/media/srt-builder.js';
import { writeAss } from '../../src/infra/media/ass-builder.js';

describe('ApproximateAligner, SubtitleCueBuilder, SRT & ASS (Fase 5 / Sprint E)', () => {
  it('aloca tempos de palavras ponderados por sílabas/pontuação (não uniformes) e monotônicos', async () => {
    const aligner = new ApproximateAligner();
    const res = await aligner.alignSegments([
      {
        segmentId: 'seg_0001',
        text: 'Sim. Inconstitucionalissimamente extraordinário!',
        startSeconds: 0,
        endSeconds: 4.0,
      },
    ]);

    expect(res.method).toBe('phrase-estimate');
    expect(res.words).toHaveLength(3);
    const w0 = res.words[0]!;
    const w1 = res.words[1]!;
    const w2 = res.words[2]!;

    expect(w0.text).toBe('Sim.');
    expect(w1.text).toBe('Inconstitucionalissimamente');
    expect(w2.text).toBe('extraordinário!');

    // Palavra longa deve receber mais duração do que "Sim."
    const durShort = w0.endSeconds - w0.startSeconds;
    const durLong = w1.endSeconds - w1.startSeconds;
    expect(durLong).toBeGreaterThan(durShort * 1.8);

    // Monotonicidade estrita
    expect(w0.startSeconds).toBeGreaterThanOrEqual(0);
    expect(w0.endSeconds).toBeGreaterThan(w0.startSeconds);
    expect(w1.startSeconds).toBeGreaterThanOrEqual(w0.endSeconds);
    expect(w2.startSeconds).toBeGreaterThanOrEqual(w1.endSeconds);
    expect(w2.endSeconds).toBeLessThanOrEqual(4.001);
  });

  it('constrói cues de legenda respeitando limite de 2 linhas, máximo de palavras, quebras de frase e sem sobreposição', async () => {
    const aligner = new ApproximateAligner();
    const alignment = await aligner.alignSegments([
      {
        segmentId: 'seg_0001',
        text: 'No primeiro capítulo desta obra clássica, acompanhamos a chegada do investigador à biblioteca silenciosa onde os manuscritos originais foram preservados por décadas.',
        startSeconds: 0,
        endSeconds: 11.5,
      },
    ]);

    const cues = buildSubtitleCues(alignment.words, {
      maxWordsPerCue: 7,
      maxCharsPerLine: 38,
      maxLines: 2,
    });

    expect(cues.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i]!;
      expect(cue.id).toBe(i + 1);
      expect(cue.endSeconds).toBeGreaterThan(cue.startSeconds);
      expect(cue.words.length).toBeLessThanOrEqual(7);
      const lines = cue.text.split('\n');
      expect(lines.length).toBeLessThanOrEqual(2);
      if (i > 0) {
        expect(cue.startSeconds).toBeGreaterThanOrEqual(cues[i - 1]!.endSeconds);
      }
    }
    expect(cues.at(-1)!.endSeconds).toBeLessThanOrEqual(11.501);
  });

  it('exporta SRT e ASS válidos (incluindo margens seguras para 9:16 e 16:9)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doctocine-subs-'));
    try {
      const srtPath = join(dir, 'captions.srt');
      const assPath = join(dir, 'captions.ass');

      await buildSrt(
        [
          {
            segmentId: 'seg_0001',
            text: 'Primeira frase curta. Segunda frase com várias palavras importantes para testar a ponderação temporal.',
            startSeconds: 0,
            endSeconds: 6.0,
          },
        ],
        srtPath,
      );

      const parsedSrt = await parseSrtCues(srtPath);
      expect(parsedSrt.length).toBeGreaterThanOrEqual(2);
      expect(parsedSrt[0]![2]).toBeGreaterThan(parsedSrt[0]![1]);

      const cues = [
        {
          id: 1,
          startSeconds: 0,
          endSeconds: 2.2,
          text: 'Primeira linha\nSegunda linha',
          words: ['Primeira', 'linha', 'Segunda', 'linha'],
        },
      ];
      await writeSrt(cues, srtPath);
      await writeAss(cues, assPath, {
        width: 1080,
        height: 1920,
        fontName: 'Arial',
      });

      const assContent = await readFile(assPath, 'utf8');
      expect(assContent).toContain('[Script Info]');
      expect(assContent).toContain('PlayResX: 1080');
      expect(assContent).toContain('PlayResY: 1920');
      expect(assContent).toContain('Dialogue: 0,0:00:00.00,0:00:02.20,Default');
      expect(assContent).toContain('Primeira linha\\NSegunda linha');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
