import { readFile, stat } from 'node:fs/promises';
import { AppError } from '../../core/errors/app-error.js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

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

  let doc;
  try {
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(data),
      useSystemFonts: true,
    });
    doc = await loadingTask.promise;
  } catch (err) {
    throw new AppError('Falha ao processar a estrutura do PDF.', {
      code: 'PDF_INVALID',
      stage: 'pdf_extraction',
      cause: err,
    });
  }

  if (doc.numPages > o.maxPages)
    throw new AppError('PDF excede o máximo configurado de páginas.', {
      code: 'PDF_PAGE_LIMIT',
      stage: 'pdf_extraction',
    });

  const pages: ExtractedPage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const str = content.items
      .map((item) => ('str' in item && typeof item.str === 'string' ? item.str : ''))
      .join(' ');
    const text = cleanText(str);
    pages.push({ pageNumber: i, text, charCount: text.length });
  }

  const hasAnyText = pages.some((p) => p.text.length > 0);
  if (!hasAnyText)
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
