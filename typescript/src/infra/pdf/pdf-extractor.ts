import { readFile, stat } from 'node:fs/promises';
import { AppError } from '../../core/errors/app-error.js';
export type ExtractedPage = { pageNumber: number; text: string; charCount: number };
export function cleanText(text: string) {
  return text
    .replace(/\x00/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
export async function extractPdf(
  path: string,
  o: { maxBytes: number; maxPages: number },
): Promise<ExtractedPage[]> {
  let s;
  try {
    s = await stat(path);
  } catch {
    throw new AppError('PDF não encontrado.', { code: 'PDF_INVALID', stage: 'pdf_extraction' });
  }
  if (s.size > o.maxBytes)
    throw new AppError('PDF excede o limite configurado.', {
      code: 'PDF_TOO_LARGE',
      stage: 'pdf_extraction',
    });
  const data = await readFile(path);
  if (data.subarray(0, 5).toString() !== '%PDF-')
    throw new AppError('Arquivo não é um PDF válido.', {
      code: 'PDF_INVALID',
      stage: 'pdf_extraction',
    });
  const text = data.toString('latin1').replace(/[^\x09\x0A\x0D\x20-\x7EÀ-ÿ]/g, ' ');
  const raw = text
    .split(/\f|\/Type\s*\/Page\b/g)
    .map(cleanText)
    .filter(Boolean);
  const pages = raw
    .slice(0, o.maxPages)
    .map((t, i) => ({ pageNumber: i + 1, text: t, charCount: t.length }));
  if (raw.length > o.maxPages)
    throw new AppError('PDF excede o máximo configurado de páginas.', {
      code: 'PDF_PAGE_LIMIT',
      stage: 'pdf_extraction',
    });
  if (!pages.length)
    throw new AppError('PDF não contém camada de texto; OCR é necessário.', {
      code: 'EMPTY_EXTRACTION',
      stage: 'pdf_extraction',
    });
  return pages;
}
export function getRange(pages: ExtractedPage[], start: number, end: number) {
  if (start < 1 || end < start || end > pages.length)
    throw new AppError(`Intervalo de páginas inválido: ${start}-${end}.`, {
      code: 'INVALID_INPUT',
      stage: 'pdf_extraction',
    });
  return pages
    .slice(start - 1, end)
    .map((p) => `[Página ${p.pageNumber}]\n${p.text}`)
    .join('\n\n');
}
