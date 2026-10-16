import { describe, expect, it } from 'vitest';
import { WhisperXAligner } from '../../src/infra/alignment/whisperx-aligner.js';

describe('WhisperXAligner — Integração segura com worker Python e fallback (Fase 5 / Sprint E)', () => {
  it('processa saída JSON estruturada de forced-alignment via runner injetado sem usar shell', async () => {
    let capturedArgs: string[] = [];
    let capturedStdin = '';

    const aligner = new WhisperXAligner({
      pythonBin: 'python3',
      workerPath: '/app/tools/alignment/worker.py',
      runnerImpl: async (_bin, args, stdinInput) => {
        capturedArgs = args;
        capturedStdin = stdinInput;
        return JSON.stringify({
          words: [
            { text: 'Olá', startSeconds: 0.05, endSeconds: 0.45, confidence: 0.98 },
            { text: 'mundo!', startSeconds: 0.48, endSeconds: 1.1, confidence: 0.95 },
          ],
          warnings: [],
        });
      },
    });

    const res = await aligner.align({
      audioPath: '/tmp/narration.wav',
      transcript: 'Olá mundo!',
      language: 'pt',
    });

    expect(capturedArgs).toEqual([
      '/app/tools/alignment/worker.py',
      '--audio',
      '/tmp/narration.wav',
      '--language',
      'pt',
    ]);
    expect(JSON.parse(capturedStdin)).toEqual({
      audioPath: '/tmp/narration.wav',
      transcript: 'Olá mundo!',
      language: 'pt',
    });
    expect(res.method).toBe('forced-alignment');
    expect(res.words).toHaveLength(2);
    expect(res.words[0]?.text).toBe('Olá');
  });

  it('faz fallback explícito para phrase-estimate com warning quando o worker Python falha e fallback está habilitado', async () => {
    const aligner = new WhisperXAligner({
      fallbackToApproximate: true,
      fallbackDurationSeconds: 2.5,
      runnerImpl: async () => {
        throw new Error('ModuleNotFoundError: No module named whisperx');
      },
    });

    const res = await aligner.align({
      audioPath: '/tmp/narration.wav',
      transcript: 'Narração com fallback ponderado seguro.',
      language: 'pt',
    });

    expect(res.method).toBe('phrase-estimate');
    expect(res.words.length).toBe(5);
    expect(res.warnings.some((w) => w.includes('forced alignment indisponível'))).toBe(true);
  });
});
