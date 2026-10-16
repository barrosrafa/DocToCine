import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pLimit from 'p-limit';
import { ArtifactStore, atomicJson } from '../../infra/storage/artifact-store.js';
import { extractPdfWithReport } from '../../infra/pdf/pdf-extractor.js';
import {
  ChapterSummarySchema,
  type ChapterBoundary,
  type ChapterPackage,
  type ChapterSummary,
} from '../../domain/schemas/chapter.schema.js';
import { VideoScriptSchema, type VideoScript } from '../../domain/schemas/script.schema.js';
import { detectChapters } from '../services/chapter-detector.js';
import { chunkChapterPages } from '../services/chapter-chunker.js';
import { ChapterSummaryService } from '../services/chapter-summary-service.js';
import { ScriptGenerator } from '../services/script-generator.js';
import { VideoPipeline } from './video-pipeline.js';
import type { LlmProvider } from '../../domain/ports/llm-provider.js';
import { CostGuard } from '../services/cost-guard.js';
import { JobReporter } from '../services/job-reporter.js';
import { AppError } from '../../core/errors/app-error.js';

export type RunResult = {
  packages: ChapterPackage[];
  videoPaths: string[];
  failedArtifacts: [number, number][];
  degraded: boolean;
  warnings: string[];
};

export type BookPipelineRunOptions = {
  resume?: boolean;
  force?: boolean;
  continueOnError?: boolean;
  maxPdfMb?: number;
  maxPdfPages?: number;
  chunkOverlapChars?: number;
  targetWpm?: number;
  tolerancePercent?: number;
  costGuard?: CostGuard;
  reporter?: JobReporter;
};

export class BookPipeline {
  constructor(
    readonly store: ArtifactStore,
    readonly video = new VideoPipeline(store),
    readonly llm?: LlmProvider,
    readonly concurrency = 3,
    readonly maxChunkChars = 12000,
  ) {}

  async run(
    pdfPath: string,
    expected = 1,
    durations: (1 | 3 | 20)[] = [1, 3, 20],
    renderVideos = false,
    options: BookPipelineRunOptions = {},
  ): Promise<RunResult> {
    const resume = options.resume ?? false;
    const force = options.force ?? false;
    const continueOnError = options.continueOnError ?? true;
    const maxBytes = (options.maxPdfMb ?? 100) * 1024 * 1024;
    const maxPages = options.maxPdfPages ?? 1000;
    const overlapChars = Math.min(
      Math.floor(this.maxChunkChars / 3),
      options.chunkOverlapChars ?? 600,
    );

    const reporter = options.reporter ?? new JobReporter(this.store.jobId);
    const costGuard = options.costGuard ?? new CostGuard({ jobId: this.store.jobId });
    const jobStart = Date.now();

    reporter.record({
      event: 'job.started',
      stage: 'job',
      elapsedMs: 0,
    });

    const pdfBytes = await readFile(pdfPath).catch(() => Buffer.alloc(0));
    const pdfHash = createHash('sha256').update(pdfBytes).digest('hex');

    const extractStart = Date.now();
    const { pages, report: extractionReport } = await extractPdfWithReport(pdfPath, {
      maxBytes,
      maxPages,
    });
    reporter.record({
      event: 'pdf.extracted',
      stage: 'pdf',
      elapsedMs: Date.now() - extractStart,
      ...(extractionReport.warnings.length > 0
        ? { warning: extractionReport.warnings.join('; ') }
        : {}),
    });

    const detectStart = Date.now();
    const detection = detectChapters(pages, expected);
    const boundaries: ChapterBoundary[] = detection.boundaries;
    reporter.record({
      event: 'chapter.detected',
      stage: 'chapter_detection',
      elapsedMs: Date.now() - detectStart,
      ...(detection.warnings.length > 0 ? { warning: detection.warnings.join('; ') } : {}),
    });

    const packages: ChapterPackage[] = [];
    const videoPaths: string[] = [];
    const failedArtifacts: [number, number][] = [];
    const globalWarnings: string[] = [...extractionReport.warnings, ...detection.warnings];
    let anyDegraded = false;

    const limit = pLimit(Math.max(1, this.concurrency));
    const summaryService = new ChapterSummaryService(this.llm);
    const scriptGen = new ScriptGenerator(this.llm, {
      ...(options.targetWpm !== undefined ? { targetWpm: options.targetWpm } : {}),
      ...(options.tolerancePercent !== undefined
        ? { tolerancePercent: options.tolerancePercent }
        : {}),
      allowDeterministicFallback: continueOnError,
    });

    for (const c of boundaries) {
      costGuard.assertWithinBudget();
      const chDir = this.store.chapterDir(c.number);
      const summaryPath = resolve(chDir, 'summary.json');
      const chapterPages = pages.slice(c.startPage - 1, c.endPage);

      const chunks = chunkChapterPages(chapterPages, {
        chapterNumber: c.number,
        maxChars: this.maxChunkChars,
        overlapChars,
        minPageChars: 10,
      });

      let summary: ChapterSummary | undefined;
      let chapterDegraded = false;
      const chapterWarnings: string[] = [];

      if (resume && !force) {
        try {
          const cachedSummary = JSON.parse(await readFile(summaryPath, 'utf8'));
          summary = ChapterSummarySchema.parse(cachedSummary);
          chapterDegraded = summary.status !== 'ai';
        } catch {
          summary = undefined;
        }
      }

      if (!summary) {
        const sumStart = Date.now();
        const outcome = await summaryService.summarizeChapter(c, chunks, {
          continueOnError,
        });
        summary = outcome.summary;
        chapterDegraded = outcome.degraded;
        chapterWarnings.push(...outcome.warnings);

        await atomicJson(summaryPath, summary);
        for (let idx = 0; idx < outcome.chunkSummaries.length; idx++) {
          await atomicJson(
            resolve(chDir, 'summary_chunks', `chunk_${String(idx + 1).padStart(2, '0')}.json`),
            outcome.chunkSummaries[idx],
          );
        }

        reporter.record({
          event: 'summary.completed',
          stage: 'summary',
          chapter: c.number,
          ...(outcome.usedModels[0] !== undefined ? { usedModel: outcome.usedModels[0] } : {}),
          elapsedMs: Date.now() - sumStart,
          degraded: outcome.degraded,
        });
      }

      const finalSummary = summary;
      const scripts = await Promise.all(
        durations.map((d) =>
          limit(async () => {
            costGuard.assertWithinBudget();
            const scriptFile = resolve(chDir, `script_${String(d).padStart(2, '0')}min.json`);
            if (resume && !force) {
              try {
                const rawScript = JSON.parse(await readFile(scriptFile, 'utf8'));
                const parsedScript = VideoScriptSchema.parse(rawScript);
                if (parsedScript.degraded) chapterDegraded = true;
                return parsedScript;
              } catch {
                // Generate fresh script
              }
            }

            const scStart = Date.now();
            const scOutcome = await scriptGen.generateWithMeta(finalSummary, c, d);
            if (scOutcome.degraded) chapterDegraded = true;
            chapterWarnings.push(...scOutcome.warnings);
            await atomicJson(scriptFile, scOutcome.script);

            reporter.record({
              event: 'script.completed',
              stage: 'script',
              chapter: c.number,
              durationPreset: d,
              ...(scOutcome.usedModel !== undefined ? { usedModel: scOutcome.usedModel } : {}),
              elapsedMs: Date.now() - scStart,
              degraded: scOutcome.degraded,
            });
            return scOutcome.script;
          }),
        ),
      );

      for (let i = 0; i < durations.length; i++) {
        const d = durations[i]!;
        const script: VideoScript = scripts[i]!;
        if (renderVideos) {
          try {
            costGuard.assertWithinBudget();
            videoPaths.push(await this.video.render(script, c, { resume, force }));
          } catch (e: unknown) {
            if (e instanceof AppError && e.code === 'BUDGET_EXCEEDED') {
              throw e;
            }
            console.error(`Falha ao renderizar vídeo do capítulo ${c.number} (${d}min):`, e);
            failedArtifacts.push([c.number, d]);
            chapterDegraded = true;
            if (!continueOnError) {
              throw e;
            }
          }
        }
      }

      if (chapterDegraded) anyDegraded = true;
      globalWarnings.push(...chapterWarnings);

      packages.push({
        schemaVersion: 2,
        chapterNumber: c.number,
        chapterTitle: c.title,
        pageRange: [c.startPage, c.endPage],
        status: finalSummary.status ?? 'ai',
        degraded: chapterDegraded,
        warnings: chapterWarnings,
        summary: finalSummary,
        scripts,
        imageIdeas: finalSummary.visualMotifs,
      });
    }

    await this.store.saveJson('book.json', {
      schemaVersion: 2,
      source: pdfPath,
      pdfHash,
      pageCount: pages.length,
      chapters: packages.length,
      extractionReport,
    });
    await this.store.saveJson('mapa_capitulos.json', {
      chapters: boundaries,
      score: detection.score,
      notes: '',
      warnings: detection.warnings,
    });

    for (const pkg of packages) {
      await this.store.saveJson(`capitulo_${String(pkg.chapterNumber).padStart(2, '0')}.json`, pkg);
    }

    const overallStatus = failedArtifacts.length
      ? 'partial'
      : anyDegraded
        ? 'degraded'
        : 'completed';

    await this.store.saveJson('manifest.json', {
      schemaVersion: 2,
      jobId: this.store.jobId,
      inputHash: pdfHash,
      status: overallStatus,
      degraded: anyDegraded || failedArtifacts.length > 0,
      chapters: packages.length,
      warnings: [...new Set(globalWarnings)],
    });
    await this.store.saveJson('resultado_completo.json', { packages });
    await this.store.saveJson(
      'roteiros_e_ideias.md',
      packages.map((pkg) => `# ${pkg.chapterTitle}\n\n${pkg.summary.thesis}`).join('\n\n'),
    );

    const usageReport = costGuard.buildReport();
    await this.store.saveJson('usage_report.json', usageReport);

    reporter.record({
      event: 'job.completed',
      stage: 'job',
      elapsedMs: Date.now() - jobStart,
      degraded: anyDegraded || failedArtifacts.length > 0,
    });

    await this.store.saveJson('run_report.json', {
      schemaVersion: 2,
      jobId: this.store.jobId,
      status: overallStatus,
      degraded: anyDegraded || failedArtifacts.length > 0,
      failedArtifacts,
      chapters: packages.length,
      videosRendered: videoPaths.length,
      warnings: [...new Set(globalWarnings)],
      events: reporter.getEvents(),
    });

    return {
      packages,
      videoPaths,
      failedArtifacts,
      degraded: anyDegraded || failedArtifacts.length > 0,
      warnings: [...new Set(globalWarnings)],
    };
  }
}
