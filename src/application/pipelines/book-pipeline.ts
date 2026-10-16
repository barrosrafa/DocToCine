import { ArtifactStore } from '../../infra/storage/artifact-store.js';
import { extractPdf } from '../../infra/pdf/pdf-extractor.js';
import {
  ChapterBoundarySchema,
  normalizeChapterSummary,
  type ChapterBoundary,
  type ChapterPackage,
} from '../../domain/schemas/chapter.schema.js';
import { ScriptGenerator } from '../services/script-generator.js';
import { VideoPipeline } from './video-pipeline.js';
export type RunResult = {
  packages: ChapterPackage[];
  videoPaths: string[];
  failedArtifacts: [number, number][];
};
export class BookPipeline {
  constructor(
    readonly store: ArtifactStore,
    readonly video = new VideoPipeline(store),
  ) {}
  async run(
    pdfPath: string,
    expected = 1,
    durations: (1 | 3 | 20)[] = [1, 3, 20],
    renderVideos = false,
  ): Promise<RunResult> {
    const pages = await extractPdf(pdfPath, { maxBytes: 100 * 1024 * 1024, maxPages: 1000 });
    const boundaries: ChapterBoundary[] = Array.from({ length: expected }, (_, i) =>
      ChapterBoundarySchema.parse({
        number: i + 1,
        title: `Capítulo ${i + 1}`,
        startPage: Math.floor((i * pages.length) / expected) + 1,
        endPage: Math.floor(((i + 1) * pages.length) / expected),
        evidence: '',
      }),
    );
    const packages: ChapterPackage[] = [];
    const videoPaths: string[] = [];
    const failedArtifacts: [number, number][] = [];
    for (const c of boundaries) {
      const summary = normalizeChapterSummary({
        title: c.title,
        thesis: pages
          .slice(c.startPage - 1, c.endPage)
          .map((p) => p.text)
          .join(' '),
        keyPoints: [],
        sourcePages: Array.from({ length: c.endPage - c.startPage + 1 }, (_, i) => c.startPage + i),
      });
      const scripts = [];
      for (const d of durations) {
        const script = await new ScriptGenerator().generate(summary, c, d);
        scripts.push(script);
        if (renderVideos)
          try {
            videoPaths.push(await this.video.render(script, c));
          } catch {
            failedArtifacts.push([c.number, d]);
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
    for (const pkg of packages)
      await this.store.saveJson(`capitulo_${String(pkg.chapterNumber).padStart(2, '0')}.json`, pkg);
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
