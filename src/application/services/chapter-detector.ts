import {
  ChapterBoundarySchema,
  ChapterMapSchema,
  type ChapterBoundary,
  type ChapterMap,
} from '../../domain/schemas/chapter.schema.js';

export type ChapterDetectionResult = {
  detectedPages: number[];
  boundaries: ChapterBoundary[];
  score: number;
  warnings: string[];
};

const HEADING_PATTERN =
  /^\s*(cap[ií]tulo|chapter|pr[oó]logo|ep[ií]logo)\b|^\s*(um|dois|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|catorze|quatorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte)\b/im;

const TOC_OR_FRONTMATTER_PATTERN =
  /^\s*(sum[aá]rio|[ií]ndice|contents|m[ií]dias sociais|cr[eé]ditos)/im;

const DOTTED_LEADER_PATTERN = /\.{4,}\s*\d+/;

export function likelyChapterPages(
  pages: { pageNumber: number; text: string }[] | string[],
): number[] {
  return pages
    .map((p, i) => ({
      text: typeof p === 'string' ? p : p.text,
      number: typeof p === 'string' ? i + 1 : p.pageNumber,
    }))
    .filter((p) => {
      if (TOC_OR_FRONTMATTER_PATTERN.test(p.text)) return false;
      if (DOTTED_LEADER_PATTERN.test(p.text.slice(0, 400))) return false;
      if ((p.text.match(/cap[ií]tulo/gi) || []).length > 2) return false;
      const firstLines = p.text.split(/\n+/).slice(0, 3).join('\n');
      return HEADING_PATTERN.test(firstLines.slice(0, 200));
    })
    .map((p) => p.number);
}

export function validateBoundaries(
  chapters: ChapterBoundary[],
  total: number,
  strict = false,
): string[] {
  const warnings: string[] = [];
  const ordered = [...chapters].sort((a, b) => a.startPage - b.startPage);
  for (let i = 0; i < ordered.length; i++) {
    const current = ordered.at(i);
    if (!current) continue;
    if (current.endPage > total || current.startPage > total)
      warnings.push(`Capítulo ${current.number} fora do intervalo do PDF.`);
    const next = ordered.at(i + 1);
    if (next && current.endPage >= next.startPage) {
      if (strict) throw new Error(`Capítulos sobrepostos: ${current.number} e ${next.number}.`);
      warnings.push(`Sobreposição entre capítulos ${current.number} e ${next.number}.`);
    }
  }
  if (strict && warnings.length) throw new Error(warnings.join(' '));
  return warnings;
}

export function normalizeBoundaries(
  map: ChapterMap,
  total: number,
  expected?: number,
): ChapterBoundary[] {
  const cs = [...map.chapters].sort((a, b) => a.startPage - b.startPage);
  const warnings = validateBoundaries(cs, total);
  for (let i = 0; i < cs.length - 1; i++) {
    const c = cs.at(i),
      n = cs.at(i + 1);
    if (c && n && c.endPage >= n.startPage) c.endPage = n.startPage - 1;
  }
  map.warnings = [...new Set([...map.warnings, ...warnings])];
  if (expected !== undefined && cs.length !== expected)
    map.warnings.push(`Esperados ${expected} capítulos, encontrados ${cs.length}.`);
  return cs.filter((c) => c.endPage >= c.startPage);
}

export function detectChapters(
  pages: { pageNumber: number; text: string }[],
  expected = 1,
): ChapterDetectionResult {
  const totalPages = pages.length;
  const warnings: string[] = [];
  if (totalPages === 0) {
    return { detectedPages: [], boundaries: [], score: 0, warnings: ['PDF sem páginas.'] };
  }

  const detectedPages = likelyChapterPages(pages);
  const targetExpected =
    expected === -1 ? (detectedPages.length > 0 ? detectedPages.length : totalPages) : expected;
  const safeExpected = Math.max(1, Math.min(targetExpected, totalPages));
  let rawBoundaries: ChapterBoundary[] = [];
  let score = 0.35;

  if (detectedPages.length >= safeExpected) {
    score = detectedPages.length === safeExpected ? 0.95 : 0.8;
    if (detectedPages.length > safeExpected) {
      warnings.push(
        `Detectados ${detectedPages.length} inícios de capítulos; limitando aos primeiros ${safeExpected} conforme solicitado.`,
      );
    }
    rawBoundaries = Array.from({ length: safeExpected }, (_, i) => {
      const start = detectedPages[i]!;
      const nextStart = i + 1 < detectedPages.length ? detectedPages[i + 1]! : null;
      const end = nextStart !== null ? Math.max(start, nextStart - 1) : totalPages;
      const startPageObj = pages.find((p) => p.pageNumber === start) ?? pages[start - 1];
      const startPageText = startPageObj?.text ?? '';
      const firstLine = startPageText.split(/\n+/)[0]?.trim().slice(0, 80) || `Capítulo ${i + 1}`;
      const title = /^(cap[ií]tulo|chapter|pr[oó]logo|ep[ií]logo)\b/i.test(firstLine)
        ? firstLine
        : `Capítulo ${i + 1}: ${firstLine}`;

      return ChapterBoundarySchema.parse({
        number: i + 1,
        title,
        startPage: start,
        endPage: Math.max(start, Math.min(totalPages, end)),
        evidence: firstLine,
      });
    });
  } else {
    if (detectedPages.length > 0) {
      warnings.push(
        `Apenas ${detectedPages.length} capítulos detectados por heurística para ${safeExpected} esperados; usando divisão proporcional.`,
      );
      score = 0.5;
    } else {
      warnings.push(
        'Nenhum cabeçalho explícito de capítulo detectado; usando divisão proporcional de páginas.',
      );
      score = 0.3;
    }

    rawBoundaries = Array.from({ length: safeExpected }, (_, i) => {
      const start = Math.floor((i * totalPages) / safeExpected) + 1;
      const end = Math.max(start, Math.floor(((i + 1) * totalPages) / safeExpected));
      const pageText = pages[start - 1]?.text ?? '';
      const snippet = pageText.split(/\n+/)[0]?.trim().slice(0, 60) ?? '';
      return ChapterBoundarySchema.parse({
        number: i + 1,
        title: `Capítulo ${i + 1}`,
        startPage: start,
        endPage: end,
        evidence: snippet,
      });
    });
  }

  const map: ChapterMap = { chapters: rawBoundaries, notes: '', warnings };
  const boundaries = normalizeBoundaries(map, totalPages, safeExpected);
  return {
    detectedPages,
    boundaries,
    score,
    warnings: map.warnings,
  };
}

export function parseChapterMap(value: unknown): ChapterMap {
  return ChapterMapSchema.parse(value);
}
