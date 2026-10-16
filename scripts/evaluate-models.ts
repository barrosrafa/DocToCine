#!/usr/bin/env tsx
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSettings } from '../src/config/settings.js';
import { OpenRouterLlmProvider } from '../src/infra/llm/openrouter-provider.js';
import { VideoScriptSchema } from '../src/domain/schemas/script.schema.js';
import {
  ChapterSummarySchema,
  type ChapterBoundary,
  type ChapterSummary,
} from '../src/domain/schemas/chapter.schema.js';
import { ScriptGenerator } from '../src/application/services/script-generator.js';
import { countWords, expectedWordRange } from '../src/application/services/script-quality-gate.js';

type ModelBenchmarkResult = {
  model: string;
  task: 'summary' | 'script';
  schemaPass: boolean;
  elapsedMs: number;
  wordCount?: number | undefined;
  targetWords?: number | undefined;
  wordDeviationPercent?: number | undefined;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  costUsd?: number | undefined;
  error?: string | undefined;
};

async function main() {
  const settings = loadSettings();
  const apiKey = settings.OPENROUTER_API_KEY;

  const candidateModels = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const models = candidateModels.length
    ? candidateModels
    : [settings.OPENROUTER_SUMMARY_MODEL, settings.OPENROUTER_SCRIPT_MODEL];

  console.log('='.repeat(70));
  console.log('DocToCine v2.0 - Avaliação de Modelos LLM via OpenRouter');
  console.log(`Modelos a testar: ${models.join(', ')}`);
  console.log('='.repeat(70));

  if (!apiKey) {
    console.warn(
      'AVISO: OPENROUTER_API_KEY não definida no ambiente. O benchmark executará validação estática de fixtures.',
    );
    const goldenRaw = await readFile(
      resolve(process.cwd(), 'tests/fixtures/golden/sample-script.json'),
      'utf8',
    );
    const parsed = VideoScriptSchema.safeParse(JSON.parse(goldenRaw));
    console.log(
      `Golden Fixture (sample-script.json) Schema Status: ${parsed.success ? 'PASS' : 'FAIL'}`,
    );
    if (parsed.success) {
      const words = countWords(parsed.data.narration);
      const range = expectedWordRange(parsed.data.durationMinutes, 135, 8);
      console.log(
        `Palavras da narração: ${words} (Faixa aceitável para 1min: ${range.min}-${range.max} palavras)`,
      );
    }
    return;
  }

  const results: ModelBenchmarkResult[] = [];
  const sampleChapter: ChapterBoundary = {
    number: 1,
    title: 'A Descoberta do Diário de 1894',
    startPage: 1,
    endPage: 5,
    evidence: 'Capítulo 1 na página 1',
  };

  const sampleSummary: ChapterSummary = ChapterSummarySchema.parse({
    title: sampleChapter.title,
    thesis:
      'O capitão Henrique encontra o diário de 1894 e descobre a rota secreta pela costa proibida.',
    keyPoints: [
      'Descoberta do diário empoeirado na biblioteca antiga',
      'As anotações sobre a tempestade e a rota das Tormentas',
      'A decisão de seguir viagem contra os avisos locais',
    ],
    examples: ['O mapa com anotações a tinta vermelha'],
    definitions: [],
    supportedClaims: [
      {
        claimId: 'claim_001',
        claim: 'Henrique localizou o diário de 1894 na biblioteca antiga.',
        sourcePages: [1, 2],
        chunkIds: ['chunk_01'],
        confidence: 'high',
      },
      {
        claimId: 'claim_002',
        claim: 'A rota pelo Cabo das Tormentas constava como atalho proibido.',
        sourcePages: [3, 4],
        chunkIds: ['chunk_01'],
        confidence: 'high',
      },
    ],
    sourcePages: [1, 2, 3, 4, 5],
    audienceTakeaway: 'Decisões corajosas exigem preparação rigorosa diante do desconhecido.',
    visualMotifs: ['Biblioteca com névoa', 'Bússola de bronze', 'Mar tempestuoso'],
    limitations: [],
  });

  for (const model of models) {
    console.log(`\nTestando modelo: ${model}...`);
    const provider = new OpenRouterLlmProvider({
      apiKey,
      baseUrl: settings.OPENROUTER_BASE_URL,
      summaryModel: model,
      scriptModel: model,
      fallbackModels: [],
      timeoutMs: 60000,
      maxRetries: 1,
    });

    // Teste 1: Geração de Resumo Estruturado
    const startSummary = Date.now();
    try {
      const summaryResult = await provider.generateStructuredWithMeta<ChapterSummary>(
        `Você é um analista editorial. Analise o seguinte texto em português e retorne APENAS um JSON válido conforme o schema:
Texto do capítulo: O capitão Henrique avistou uma ilha misteriosa coberta por névoa densa. No diário de bordo de 1894, encontrou coordenadas detalhadas e um aviso sobre correntes marítimas perigosas.`,
        ChapterSummarySchema,
        { task: 'summary' },
      );
      results.push({
        model,
        task: 'summary',
        schemaPass: true,
        elapsedMs: Date.now() - startSummary,
        promptTokens: summaryResult.usage?.promptTokens,
        completionTokens: summaryResult.usage?.completionTokens,
        costUsd: summaryResult.usage?.estimatedCostUsd,
      });
      console.log(`  ✓ Resumo: Schema OK (${Date.now() - startSummary}ms)`);
    } catch (err: unknown) {
      results.push({
        model,
        task: 'summary',
        schemaPass: false,
        elapsedMs: Date.now() - startSummary,
        error: err instanceof Error ? err.message : String(err),
      });
      console.log(`  ✗ Resumo: Falhou (${err instanceof Error ? err.message : String(err)})`);
    }

    // Teste 2: Geração de Roteiro de 1 Minuto usando ScriptGenerator
    const startScript = Date.now();
    try {
      const scriptGenerator = new ScriptGenerator(provider, {
        allowDeterministicFallback: false,
        targetWpm: 135,
        tolerancePercent: 8,
      });
      const outcome = await scriptGenerator.generateWithMeta(sampleSummary, sampleChapter, 1);
      const words = countWords(outcome.script.narration);
      const targetWords = 135;
      const deviation = Math.abs(((words - targetWords) / targetWords) * 100);

      results.push({
        model,
        task: 'script',
        schemaPass: true,
        elapsedMs: Date.now() - startScript,
        wordCount: words,
        targetWords,
        wordDeviationPercent: Number(deviation.toFixed(1)),
      });
      console.log(
        `  ✓ Roteiro: Schema OK, ${words} palavras (desvio: ${deviation.toFixed(1)}%) (${Date.now() - startScript}ms)`,
      );
    } catch (err: unknown) {
      results.push({
        model,
        task: 'script',
        schemaPass: false,
        elapsedMs: Date.now() - startScript,
        error: err instanceof Error ? err.message : String(err),
      });
      console.log(`  ✗ Roteiro: Falhou (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('TABELA DE RESULTADOS');
  console.log('='.repeat(70));
  console.table(
    results.map((r) => ({
      Modelo: r.model,
      Tarefa: r.task,
      Schema: r.schemaPass ? 'PASS' : 'FAIL',
      'Tempo (ms)': r.elapsedMs,
      Palavras: r.wordCount ?? '-',
      'Desvio %': r.wordDeviationPercent !== undefined ? `${r.wordDeviationPercent}%` : '-',
      'Custo (USD)': r.costUsd !== undefined ? `$${r.costUsd.toFixed(5)}` : 'N/A',
    })),
  );
}

main().catch((err) => {
  console.error('Erro na execução do benchmark:', err);
  process.exitCode = 1;
});
