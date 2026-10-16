import { describe, expect, it } from 'vitest';
import { ChapterSummaryService } from '../../src/application/services/chapter-summary-service.js';
import type { LlmCallOptions, LlmProvider } from '../../src/domain/ports/llm-provider.js';
import type { TextChunk } from '../../src/application/services/chapter-chunker.js';
import { ChapterBoundarySchema } from '../../src/domain/schemas/chapter.schema.js';

describe('ChapterSummaryService — Resumo por chunk e consolidação hierárquica (Fase 2 / Sprint B)', () => {
  const sampleChunks: TextChunk[] = [
    {
      chunkId: 'ch01_chunk_01',
      chapterNumber: 1,
      index: 0,
      text: '[Página 1]\nO pesquisador Henrique descobre o diário de bordo de 1894 na biblioteca.\n\n[Página 2]\nO diário descreve a rota secreta pelo Cabo das Tormentas.',
      sourcePages: [1, 2],
      startChar: 0,
      endChar: 155,
    },
    {
      chunkId: 'ch01_chunk_02',
      chapterNumber: 1,
      index: 1,
      text: '[Página 3]\nHelena analisa os mapas astronômicos anexados ao diário.\n\n[Página 4]\nEles concluem que a expedição original alcançou a ilha oculta em novembro.',
      sourcePages: [3, 4],
      startChar: 130,
      endChar: 290,
    },
  ];

  const boundary = ChapterBoundarySchema.parse({
    number: 1,
    title: 'Capítulo 1: O Diário de 1894',
    startPage: 1,
    endPage: 4,
    evidence: 'Capítulo 1: O Diário de 1894',
  });

  it('resume todos os chunks e consolida hierarquicamente preservando sourcePages e chunkIds nas claims', async () => {
    const prompts: string[] = [];
    const mockLlm: LlmProvider = {
      async generateStructured<T>(
        prompt: string,
        schema: { parse(value: unknown): T },
        _options?: LlmCallOptions,
      ): Promise<T> {
        prompts.push(prompt);
        if (prompt.includes('ch01_chunk_01')) {
          return schema.parse({
            title: 'Chunk 1',
            thesis: 'Henrique encontra o diário de 1894 com a rota secreta.',
            keyPoints: ['Descoberta do diário na biblioteca', 'Rota pelo Cabo das Tormentas'],
            supportedClaims: [
              {
                claimId: 'c1',
                claim: 'Henrique descobre o diário de 1894 na biblioteca.',
                sourcePages: [1],
                chunkIds: ['ch01_chunk_01'],
                confidence: 'high',
              },
            ],
            sourcePages: [1, 2],
            visualMotifs: ['Biblioteca antiga à meia-luz'],
          });
        }
        if (prompt.includes('ch01_chunk_02')) {
          return schema.parse({
            title: 'Chunk 2',
            thesis: 'Helena decifra os mapas astronômicos que provam a chegada à ilha.',
            keyPoints: ['Análise dos mapas astronômicos por Helena', 'Chegada à ilha em novembro'],
            supportedClaims: [
              {
                claimId: 'c2',
                claim: 'Helena analisa os mapas astronômicos anexados ao diário.',
                sourcePages: [3],
                chunkIds: ['ch01_chunk_02'],
                confidence: 'high',
              },
            ],
            sourcePages: [3, 4],
            visualMotifs: ['Mapas estelares sobre mesa de carvalho'],
          });
        }
        // Consolidação hierárquica
        return schema.parse({
          title: 'Capítulo 1: O Diário de 1894',
          thesis:
            'Henrique e Helena descobrem o diário de 1894 e decifram os mapas astronômicos que comprovam a chegada à ilha oculta.',
          keyPoints: [
            'Descoberta do diário na biblioteca',
            'Rota pelo Cabo das Tormentas',
            'Análise dos mapas astronômicos por Helena',
          ],
          supportedClaims: [
            {
              claimId: 'claim_001',
              claim: 'Henrique descobre o diário de 1894 na biblioteca.',
              sourcePages: [1],
              chunkIds: ['ch01_chunk_01'],
              confidence: 'high',
            },
            {
              claimId: 'claim_002',
              claim: 'Helena analisa os mapas astronômicos anexados ao diário.',
              sourcePages: [3],
              chunkIds: ['ch01_chunk_02'],
              confidence: 'high',
            },
          ],
          sourcePages: [1, 2, 3, 4],
          audienceTakeaway: 'Os registros históricos mudam o rumo da investigação.',
          visualMotifs: ['Biblioteca antiga à meia-luz', 'Mapas estelares sobre mesa de carvalho'],
        });
      },
    };

    const service = new ChapterSummaryService(mockLlm);
    const result = await service.summarizeChapter(boundary, sampleChunks, {
      continueOnError: false,
    });

    expect(prompts).toHaveLength(3); // 2 chunks + 1 merge
    expect(result.status).toBe('ai');
    expect(result.degraded).toBe(false);
    expect(result.summary.sourcePages).toEqual([1, 2, 3, 4]);
    expect(result.summary.supportedClaims).toHaveLength(2);
    expect(result.summary.supportedClaims[0]?.sourcePages).toEqual([1]);
    expect(result.summary.supportedClaims[1]?.sourcePages).toEqual([3]);
  });

  it('marca status partial/degraded quando um chunk falha com continueOnError=true', async () => {
    let call = 0;
    const partialLlm: LlmProvider = {
      async generateStructured<T>(
        _prompt: string,
        schema: { parse(value: unknown): T },
      ): Promise<T> {
        call++;
        if (call === 2) {
          throw new Error('Timeout no segundo chunk');
        }
        return schema.parse({
          title: 'Capítulo 1 Parcial',
          thesis: 'Resumo obtido com falha parcial no chunk 2.',
          keyPoints: ['Descoberta do diário na biblioteca'],
          supportedClaims: [
            {
              claimId: 'c1',
              claim: 'Henrique descobre o diário de 1894.',
              sourcePages: [1],
              chunkIds: ['ch01_chunk_01'],
              confidence: 'medium',
            },
          ],
          sourcePages: [1, 2],
          visualMotifs: ['Biblioteca antiga'],
        });
      },
    };

    const service = new ChapterSummaryService(partialLlm);
    const result = await service.summarizeChapter(boundary, sampleChunks, {
      continueOnError: true,
    });

    expect(result.status).toBe('partial');
    expect(result.degraded).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
