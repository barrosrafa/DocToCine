import { ArtifactStore } from '../../infra/storage/artifact-store.js';
import { extractPdf } from '../../infra/pdf/pdf-extractor.js';
import {
  ChapterBoundarySchema,
  ChapterSummarySchema,
  normalizeChapterSummary,
  type ChapterBoundary,
  type ChapterPackage,
  type ChapterSummary,
} from '../../domain/schemas/chapter.schema.js';
import { likelyChapterPages } from '../services/chapter-detector.js';
import { ScriptGenerator } from '../services/script-generator.js';
import { VideoPipeline } from './video-pipeline.js';
import type { LlmProvider } from '../../domain/ports/llm-provider.js';

export type RunResult = {
  packages: ChapterPackage[];
  videoPaths: string[];
  failedArtifacts: [number, number][];
};

export class BookPipeline {
  constructor(
    readonly store: ArtifactStore,
    readonly video = new VideoPipeline(store),
    readonly llm?: LlmProvider,
  ) {}

  async run(
    pdfPath: string,
    expected = 1,
    durations: (1 | 3 | 20)[] = [1, 3, 20],
    renderVideos = false,
  ): Promise<RunResult> {
    const pages = await extractPdf(pdfPath, { maxBytes: 100 * 1024 * 1024, maxPages: 1000 });

    const detected = likelyChapterPages(pages);
    let boundaries: ChapterBoundary[] = [];

    if (detected.length >= expected) {
      boundaries = Array.from({ length: expected }, (_, i) => {
        const start = detected[i]!;
        const nextStart = i + 1 < detected.length ? detected[i + 1]! : null;
        const end =
          nextStart !== null
            ? nextStart - 1
            : i === expected - 1
              ? pages.length
              : Math.floor(((i + 1) * pages.length) / expected);

        const startPageText = pages[start - 1]?.text || '';
        const firstLine = startPageText.split(/\n+/)[0]?.trim().slice(0, 40) || `Capítulo ${i + 1}`;
        const title = firstLine.toLowerCase().startsWith('capítulo')
          ? firstLine
          : `Capítulo ${i + 1}: ${firstLine}`;

        return ChapterBoundarySchema.parse({
          number: i + 1,
          title,
          startPage: start,
          endPage: Math.max(start, end),
          evidence: firstLine,
        });
      });
    } else {
      boundaries = Array.from({ length: expected }, (_, i) =>
        ChapterBoundarySchema.parse({
          number: i + 1,
          title: `Capítulo ${i + 1}`,
          startPage: Math.floor((i * pages.length) / expected) + 1,
          endPage: Math.floor(((i + 1) * pages.length) / expected),
          evidence: '',
        }),
      );
    }

    const packages: ChapterPackage[] = [];
    const videoPaths: string[] = [];
    const failedArtifacts: [number, number][] = [];

    for (const c of boundaries) {
      const chapterPages = pages.slice(c.startPage - 1, c.endPage);
      const cleanChapterText = chapterPages
        .map((p) => p.text)
        .filter((t) => t.length > 30)
        .join(' ');
      const sampleExcerpt = cleanChapterText.slice(0, 8000);

      let summary: ChapterSummary | null = null;
      if (this.llm) {
        try {
          summary = await this.llm.generateStructured(
            `Você é um crítico literário experiente. Analise o seguinte trecho do ${c.title} e gere um resumo conciso e envolvente.
Retorne um JSON com os campos:
- title: string (título do capítulo)
- thesis: string (resumo conciso de 1 a 2 parágrafos com a tese central e os principais fatos do capítulo)
- keyPoints: array de 3 a 5 strings (os principais pontos da trama ou ideias-chave)
- audienceTakeaway: string (o principal impacto ou reflexão para o leitor)
- visualMotifs: array de 3 a 5 strings (elementos visuais e cenários marcantes)

Texto do capítulo:
${sampleExcerpt}`,
            ChapterSummarySchema,
          );
        } catch {
          summary = null;
        }
      }

      if (!summary) {
        const firstParagraphs =
          cleanChapterText
            .split(/\n\n+/)
            .filter((p) => p.length > 50)
            .slice(0, 3)
            .join('\n\n') || cleanChapterText.slice(0, 600);

        summary = normalizeChapterSummary({
          title: c.title,
          thesis:
            firstParagraphs.slice(0, 1000) ||
            `Este capítulo apresenta os acontecimentos centrais de ${c.title}.`,
          keyPoints: [
            `Início e contextualização de ${c.title}`,
            'Desenvolvimento das tensões e conflitos centrais',
            'Desfecho do capítulo e ganchos para a continuidade',
          ],
          audienceTakeaway: `Compreensão indispensável sobre os rumos narrativos de ${c.title}.`,
          visualMotifs: [
            `Cenário inicial marcante de ${c.title}`,
            'Atmosfera densa de suspense e revelação',
            'Clímax visual e encerramento do capítulo',
          ],
          sourcePages: Array.from(
            { length: c.endPage - c.startPage + 1 },
            (_, i) => c.startPage + i,
          ),
        });
      }

      const scripts = [];
      const scriptGen = new ScriptGenerator(this.llm);
      for (const d of durations) {
        const script = await scriptGen.generate(summary, c, d);
        scripts.push(script);
        if (renderVideos) {
          try {
            videoPaths.push(await this.video.render(script, c));
          } catch (e) {
            console.error(`Falha ao renderizar vídeo do capítulo ${c.number} (${d}min):`, e);
            failedArtifacts.push([c.number, d]);
          }
        }
      }

      packages.push({
        chapterNumber: c.number,
        chapterTitle: c.title,
        pageRange: [c.startPage, c.endPage],
        summary,
        scripts,
        imageIdeas: summary.visualMotifs,
      });
    }

    await this.store.saveJson('book.json', { source: pdfPath, chapters: packages.length });
    await this.store.saveJson('mapa_capitulos.json', {
      chapters: boundaries,
      notes: '',
      warnings: [],
    });

    for (const pkg of packages) {
      await this.store.saveJson(`capitulo_${String(pkg.chapterNumber).padStart(2, '0')}.json`, pkg);
    }

    await this.store.saveJson('manifest.json', {
      status: failedArtifacts.length ? 'partial' : 'completed',
      chapters: packages.length,
    });
    await this.store.saveJson('resultado_completo.json', { packages });
    await this.store.saveJson(
      'roteiros_e_ideias.md',
      packages.map((pkg) => `# ${pkg.chapterTitle}\n\n${pkg.summary.thesis}`).join('\n\n'),
    );
    await this.store.saveJson('run_report.json', { failedArtifacts, chapters: packages.length });

    return { packages, videoPaths, failedArtifacts };
  }
}
