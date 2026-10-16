import { describe, expect, it } from 'vitest';
import {
  expectedWordRange,
  countWords,
  evaluateScriptQuality,
} from '../../src/application/services/script-quality-gate.js';
import { ScriptGenerator } from '../../src/application/services/script-generator.js';
import {
  ChapterBoundarySchema,
  normalizeChapterSummary,
} from '../../src/domain/schemas/chapter.schema.js';
import type { LlmCallOptions, LlmProvider } from '../../src/domain/ports/llm-provider.js';
import { AppError } from '../../src/core/errors/app-error.js';

describe('ScriptQualityGate & ScriptGenerator (Fase 3 / Sprint C)', () => {
  const boundary = ChapterBoundarySchema.parse({
    number: 1,
    title: 'Capítulo 1: A Bússola de Latão',
    startPage: 1,
    endPage: 6,
  });

  const summary = normalizeChapterSummary({
    title: 'Capítulo 1: A Bússola de Latão',
    thesis: 'O capitão descobre que a bússola aponta para uma anomalia magnética na costa norte.',
    keyPoints: [
      'A anomalia magnética altera a rota do navio',
      'O diário do navegador confirma o fenômeno',
      'A tripulação decide explorar a enseada oculta',
    ],
    supportedClaims: [
      {
        claimId: 'claim_001',
        claim: 'A bússola aponta para uma anomalia magnética na costa norte.',
        sourcePages: [2, 3],
        chunkIds: ['ch01_chunk_01'],
        confidence: 'high',
      },
    ],
    sourcePages: [1, 2, 3, 4, 5, 6],
  });

  it('calcula faixa de palavras esperada por duração (1, 3 e 20 min) com WPM e tolerância', () => {
    const r1 = expectedWordRange(1, 135, 8);
    expect(r1).toEqual({ min: 124, max: 146 });

    const r3 = expectedWordRange(3, 135, 8);
    expect(r3).toEqual({ min: 372, max: 438 });

    const r20 = expectedWordRange(20, 135, 8);
    expect(r20).toEqual({ min: 2484, max: 2916 });
  });

  it('faz no máximo 1 revisão quando a contagem de palavras está fora da meta e preserva claims/sourcePages', async () => {
    let calls = 0;
    const targetWords = Array.from({ length: 132 }, (_, i) => `palavra${i + 1}`).join(' ');
    const validNarration = `A anomalia magnética altera a rota do navio no início da viagem. ${targetWords.slice(0, 300)}\n\nO diário do navegador confirma o fenômeno observado na costa. ${targetWords.slice(300, 600)}\n\nA tripulação decide explorar a enseada oculta ao amanhecer. ${targetWords.slice(600)}`;

    const mockLlm: LlmProvider = {
      async generateStructured<T>(
        _prompt: string,
        schema: { parse(value: unknown): T },
        _options?: LlmCallOptions,
      ): Promise<T> {
        calls++;
        if (calls === 1) {
          // Muito curto (apenas 9 palavras)
          return schema.parse({
            title: boundary.title,
            durationMinutes: 1,
            hook: 'Gancho inicial.',
            beats: ['Beat 1', 'Beat 2', 'Beat 3'],
            narration: 'Parágrafo um curto.\n\nParágrafo dois curto.\n\nParágrafo três curto.',
            cta: 'Siga para o próximo capítulo.',
            bRollAndVisuals: ['Cena 1', 'Cena 2', 'Cena 3'],
          });
        }
        return schema.parse({
          title: boundary.title,
          durationMinutes: 1,
          hook: 'O que faz uma bússola trair o próprio norte?',
          beats: ['Anomalia', 'Diário', 'Decisão'],
          narration: validNarration,
          cta: 'Inscreva-se para o Capítulo 2.',
          bRollAndVisuals: ['Bússola antiga', 'Diário aberto', 'Navio na neblina'],
        });
      },
    };

    const gen = new ScriptGenerator(mockLlm, {
      targetWpm: 135,
      tolerancePercent: 15,
    });
    const outcome = await gen.generateWithMeta(summary, boundary, 1);

    expect(calls).toBe(2); // 1 geração inicial + 1 revisão
    expect(outcome.degraded).toBe(false);
    expect(outcome.revisionApplied).toBe(true);
    expect(outcome.script.sourcePages).toEqual([1, 2, 3, 4, 5, 6]);
    expect(outcome.script.claims).toHaveLength(1);
    expect(countWords(outcome.script.narration)).toBeGreaterThanOrEqual(114);
  });

  it('não engole erro de autenticação (LLM_AUTH) nem mascara falha como AI success quando fallback determinístico é desativado', async () => {
    const failingAuthLlm: LlmProvider = {
      async generateStructured(): Promise<never> {
        throw new AppError('Chave inválida', {
          code: 'LLM_AUTH',
          stage: 'llm',
          retryable: false,
        });
      },
    };

    const gen = new ScriptGenerator(failingAuthLlm);
    await expect(gen.generate(summary, boundary, 1)).rejects.toThrow('Chave inválida');

    const transientFailingLlm: LlmProvider = {
      async generateStructured(): Promise<never> {
        throw new Error('503 Service Unavailable');
      },
    };

    const strictGen = new ScriptGenerator(transientFailingLlm, {
      allowDeterministicFallback: false,
    });
    await expect(strictGen.generate(summary, boundary, 1)).rejects.toThrow(
      '503 Service Unavailable',
    );
  });

  it('detecta artefatos de IA e parágrafos duplicados no ScriptQualityGate', () => {
    const badScript = {
      schemaVersion: 2 as const,
      title: 'Teste',
      durationMinutes: 1 as const,
      language: 'pt-BR' as const,
      targetAudience: 'Leitores',
      tone: 'cinematografico' as const,
      hook: 'Hook',
      beats: ['A', 'B', 'C'],
      narration:
        'Como modelo de linguagem e como IA, vou resumir o capítulo.\n\nParágrafo repetido exatamente igual.\n\nParágrafo repetido exatamente igual.',
      segments: [],
      cta: '',
      bRollAndVisuals: [],
      sourcePages: [1],
      claims: [],
      degraded: false,
      warnings: [],
    };

    const gate = evaluateScriptQuality(badScript, summary, {
      targetWpm: 135,
      tolerancePercent: 10,
    });
    expect(gate.passed).toBe(false);
    expect(gate.issues.some((i) => i.includes('meta-linguagem de IA'))).toBe(true);
    expect(gate.issues.some((i) => i.includes('Parágrafo duplicado'))).toBe(true);
  });
});
