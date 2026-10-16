import type { ChapterBoundary, ChapterMap } from '../../domain/schemas/chapter.schema.js';
import { ChapterMapSchema } from '../../domain/schemas/chapter.schema.js';
export function likelyChapterPages(
  pages: { pageNumber: number; text: string }[] | string[],
): number[] {
  const pattern =
    /^\s*(cap[ií]tulo|chapter|pr[oó]logo|ep[ií]logo)\b|^\s*(um|dois|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|catorze|quatorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte)\b/im;
  return pages
    .map((p, i) => ({ text: typeof p === 'string' ? p : p.text, number: i + 1 }))
    .filter((p) => {
      if (/^\s*(sum[aá]rio|[ií]ndice|contents|m[ií]dias sociais|cr[eé]ditos)/im.test(p.text))
        return false;
      if ((p.text.match(/cap[ií]tulo/gi) || []).length > 2) return false;
      return pattern.test(p.text.slice(0, 200));
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
export function parseChapterMap(value: unknown): ChapterMap {
  return ChapterMapSchema.parse(value);
}
