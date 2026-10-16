import {
  ChapterSummarySchema,
  normalizeChapterSummary,
  type ChapterBoundary,
  type ChapterSummary,
  type SummaryRunStatus,
  type SupportedClaim,
} from '../../domain/schemas/chapter.schema.js';
import type { LlmProvider } from '../../domain/ports/llm-provider.js';
import type { TextChunk } from './chapter-chunker.js';
import { AppError } from '../../core/errors/app-error.js';

export type ChapterSummaryOutcome = {
  summary: ChapterSummary;
  chunkSummaries: ChapterSummary[];
  status: SummaryRunStatus;
  degraded: boolean;
  warnings: string[];
  usedModels: string[];
};

function sanitizeClaimPages(
  claims: SupportedClaim[],
  validMinPage: number,
  validMaxPage: number,
  fallbackPages: number[],
  defaultChunkId?: string,
): SupportedClaim[] {
  return claims.map((c, idx) => {
    const validPages = c.sourcePages.filter((p) => p >= validMinPage && p <= validMaxPage);
    const resolvedPages = validPages.length > 0 ? validPages : fallbackPages.slice(0, 1);
    const chunkIds =
      c.chunkIds && c.chunkIds.length > 0 ? c.chunkIds : defaultChunkId ? [defaultChunkId] : [];
    return {
      claimId: c.claimId || `claim_${String(idx + 1).padStart(3, '0')}`,
      claim: c.claim,
      sourcePages: [...new Set(resolvedPages)].sort((a, b) => a - b),
      chunkIds,
      confidence: c.confidence ?? 'medium',
    };
  });
}

export function buildHeuristicSummary(
  boundary: ChapterBoundary,
  chunks: TextChunk[],
  warnings: string[] = [],
): ChapterSummary {
  const fullText = chunks
    .map((c) => c.text.replace(/\[Página \d+\]\s*/g, ''))
    .join('\n\n')
    .trim();
  const paragraphs = fullText
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 40);

  const thesis =
    paragraphs.slice(0, 3).join('\n\n').slice(0, 1000) ||
    fullText.slice(0, 600) ||
    `Este capítulo apresenta os acontecimentos centrais de ${boundary.title}.`;

  const allPages = [
    ...new Set(
      chunks.length > 0
        ? chunks.flatMap((c) => c.sourcePages)
        : Array.from(
            { length: boundary.endPage - boundary.startPage + 1 },
            (_, i) => boundary.startPage + i,
          ),
    ),
  ].sort((a, b) => a - b);

  const keyPoints =
    paragraphs.length >= 3
      ? paragraphs.slice(0, 4).map((p) => p.slice(0, 180))
      : [
          `Início e contextualização de ${boundary.title}`,
          'Desenvolvimento das tensões e conflitos centrais',
          'Desfecho do capítulo e ganchos para a continuidade',
        ];

  const supportedClaims: SupportedClaim[] = keyPoints.map((kp, i) => ({
    claimId: `heur_claim_${String(i + 1).padStart(3, '0')}`,
    claim: kp,
    sourcePages: [allPages[Math.min(i, allPages.length - 1)] ?? boundary.startPage],
    chunkIds: chunks[Math.min(i, Math.max(0, chunks.length - 1))]
      ? [chunks[Math.min(i, Math.max(0, chunks.length - 1))]!.chunkId]
      : [],
    confidence: 'low',
  }));

  return normalizeChapterSummary({
    schemaVersion: 2,
    status: 'heuristic',
    title: boundary.title,
    thesis,
    keyPoints,
    supportedClaims,
    sourcePages: allPages,
    audienceTakeaway: `Compreensão essencial sobre os rumos narrativos de ${boundary.title}.`,
    visualMotifs: [
      `Cenário inicial marcante de ${boundary.title}`,
      'Atmosfera densa de descoberta e tensão',
      'Clímax visual e encerramento do capítulo',
    ],
    limitations: ['Resumo gerado por extração heurística local sem inferência de modelo LLM.'],
    warnings,
  });
}

export class ChapterSummaryService {
  constructor(private readonly llm?: LlmProvider) {}

  private async callSummaryLlm(
    prompt: string,
  ): Promise<{ data: ChapterSummary; usedModel?: string }> {
    if (!this.llm) {
      throw new Error('LLM provider não configurado.');
    }
    if (this.llm.generateStructuredWithMeta) {
      const meta = await this.llm.generateStructuredWithMeta(prompt, ChapterSummarySchema, {
        task: 'summary',
      });
      return { data: normalizeChapterSummary(meta.data), usedModel: meta.usedModel };
    }
    const raw = await this.llm.generateStructured(prompt, ChapterSummarySchema, {
      task: 'summary',
    });
    return { data: normalizeChapterSummary(raw) };
  }

  async summarizeChapter(
    boundary: ChapterBoundary,
    chunks: TextChunk[],
    options: { continueOnError?: boolean } = {},
  ): Promise<ChapterSummaryOutcome> {
    const continueOnError = options.continueOnError ?? true;
    const warnings: string[] = [];
    const usedModels = new Set<string>();

    if (!this.llm || chunks.length === 0) {
      warnings.push(
        !this.llm
          ? 'LLM ausente; resumo construído heuristicamente.'
          : 'Capítulo sem chunks; resumo construído heuristicamente.',
      );
      const summary = buildHeuristicSummary(boundary, chunks, warnings);
      return {
        summary,
        chunkSummaries: [],
        status: 'heuristic',
        degraded: true,
        warnings,
        usedModels: [],
      };
    }

    const chunkSummaries: ChapterSummary[] = [];
    let failedChunks = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const prompt = `Tarefa: resumir fielmente o CHUNK ${i + 1}/${chunks.length} (${chunk.chunkId}) do capítulo "${boundary.title}".
Use somente o texto-fonte. Não invente fatos, nomes, diálogos, motivos nem sequência de eventos.
Diferencie fatos explícitos de inferências; sinalize incerteza em limitations.
Cada afirmação importante em supportedClaims deve citar uma ou mais páginas presentes nos marcadores [Página N] (${chunk.sourcePages.join(', ')}).
Retorne um objeto JSON com:
- title: string
- thesis: string (resumo factual denso de 1 a 2 parágrafos)
- keyPoints: array de 3 a 5 strings
- supportedClaims: array de objetos { claimId, claim, sourcePages, chunkIds: ["${chunk.chunkId}"], confidence }
- sourcePages: array de números de páginas utilizadas
- audienceTakeaway: string
- visualMotifs: array de 2 a 4 strings descrevendo cenas visuais concretas do trecho
- limitations: array de strings

Texto do chunk (${chunk.chunkId}):
${chunk.text}`;

      try {
        const { data, usedModel } = await this.callSummaryLlm(prompt);
        if (usedModel) usedModels.add(usedModel);
        const sanitizedClaims = sanitizeClaimPages(
          data.supportedClaims,
          boundary.startPage,
          boundary.endPage,
          chunk.sourcePages,
          chunk.chunkId,
        );
        const validPages = data.sourcePages.filter(
          (p) => p >= boundary.startPage && p <= boundary.endPage,
        );
        chunkSummaries.push({
          ...data,
          supportedClaims: sanitizedClaims,
          sourcePages: [...new Set([...validPages, ...chunk.sourcePages])].sort((a, b) => a - b),
        });
      } catch (err: unknown) {
        if (err instanceof AppError && !err.retryable) {
          throw err;
        }
        failedChunks++;
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Falha ao resumir ${chunk.chunkId}: ${msg}`);
        if (!continueOnError) {
          throw err;
        }
      }
    }

    if (chunkSummaries.length === 0) {
      warnings.push('Todos os chunks falharam na síntese via IA; aplicando resumo heurístico.');
      const heuristic = buildHeuristicSummary(boundary, chunks, warnings);
      return {
        summary: heuristic,
        chunkSummaries: [],
        status: 'heuristic',
        degraded: true,
        warnings,
        usedModels: [...usedModels],
      };
    }

    const status: SummaryRunStatus = failedChunks > 0 ? 'partial' : 'ai';

    if (chunkSummaries.length === 1 && chunks.length === 1) {
      const single = chunkSummaries[0]!;
      const finalSingle: ChapterSummary = {
        ...single,
        schemaVersion: 2,
        status,
        title: single.title || boundary.title,
        warnings,
      };
      return {
        summary: finalSingle,
        chunkSummaries,
        status,
        degraded: status !== 'ai',
        warnings,
        usedModels: [...usedModels],
      };
    }

    // Consolidação hierárquica dos resumos dos chunks
    const mergePayload = chunkSummaries.map((cs, idx) => ({
      chunkId: chunks[idx]?.chunkId ?? `chunk_${idx + 1}`,
      thesis: cs.thesis,
      keyPoints: cs.keyPoints,
      supportedClaims: cs.supportedClaims,
      sourcePages: cs.sourcePages,
      visualMotifs: cs.visualMotifs,
    }));

    const mergePrompt = `Tarefa: consolidar hierarquicamente os ${chunkSummaries.length} resumos parciais do capítulo "${boundary.title}" (páginas ${boundary.startPage}-${boundary.endPage}).
Regras estritas:
1. Preserve a ordem cronológica/argumentativa e una pontos duplicados causados por overlap.
2. Não invente transições nem fatos ausentes nos resumos parciais.
3. Preserve as referências de páginas (sourcePages) e chunkIds em supportedClaims.
4. Retorne APENAS o JSON final no schema ChapterSummarySchema.

Resumos parciais por chunk:
${JSON.stringify(mergePayload, null, 2)}`;

    try {
      const { data: merged, usedModel } = await this.callSummaryLlm(mergePrompt);
      if (usedModel) usedModels.add(usedModel);
      const allChunkPages = [...new Set(chunkSummaries.flatMap((c) => c.sourcePages))].sort(
        (a, b) => a - b,
      );

      const combinedClaims = [...merged.supportedClaims];
      for (const cs of chunkSummaries) {
        for (const claim of cs.supportedClaims) {
          const alreadyExists = combinedClaims.some(
            (existing) => existing.claim.trim().toLowerCase() === claim.claim.trim().toLowerCase(),
          );
          if (!alreadyExists) {
            combinedClaims.push(claim);
          }
        }
      }

      const mergedClaims = sanitizeClaimPages(
        combinedClaims,
        boundary.startPage,
        boundary.endPage,
        allChunkPages,
      );

      const consolidated: ChapterSummary = normalizeChapterSummary({
        ...merged,
        schemaVersion: 2,
        status,
        title: merged.title || boundary.title,
        supportedClaims: mergedClaims,
        sourcePages: [
          ...new Set([
            ...merged.sourcePages.filter((p) => p >= boundary.startPage && p <= boundary.endPage),
            ...allChunkPages,
          ]),
        ].sort((a, b) => a - b),
        warnings,
      });

      return {
        summary: consolidated,
        chunkSummaries,
        status,
        degraded: status !== 'ai',
        warnings,
        usedModels: [...usedModels],
      };
    } catch (err: unknown) {
      if (err instanceof AppError && !err.retryable) {
        throw err;
      }
      if (!continueOnError) {
        throw err;
      }
      warnings.push(
        `Consolidação hierárquica via LLM falhou (${err instanceof Error ? err.message : String(err)}); unindo resumos de chunks localmente.`,
      );
      const fallbackMerged: ChapterSummary = normalizeChapterSummary({
        schemaVersion: 2,
        status: 'partial',
        title: boundary.title,
        thesis: chunkSummaries.map((c) => c.thesis).join('\n\n'),
        keyPoints: [...new Set(chunkSummaries.flatMap((c) => c.keyPoints))].slice(0, 8),
        supportedClaims: chunkSummaries.flatMap((c) => c.supportedClaims),
        sourcePages: [...new Set(chunkSummaries.flatMap((c) => c.sourcePages))].sort(
          (a, b) => a - b,
        ),
        audienceTakeaway:
          chunkSummaries.at(-1)?.audienceTakeaway || `Síntese consolidada de ${boundary.title}.`,
        visualMotifs: [...new Set(chunkSummaries.flatMap((c) => c.visualMotifs))].slice(0, 6),
        warnings,
      });
      return {
        summary: fallbackMerged,
        chunkSummaries,
        status: 'partial',
        degraded: true,
        warnings,
        usedModels: [...usedModels],
      };
    }
  }
}
