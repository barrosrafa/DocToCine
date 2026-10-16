import { readFile, stat } from 'node:fs/promises';
import { AppError } from '../../core/errors/app-error.js';
import {
  ExtractedPageSchema,
  PdfExtractionReportSchema,
  type ExtractedPage,
  type PdfExtractionReport,
} from '../../domain/schemas/document.schema.js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

export type { ExtractedPage, PdfExtractionReport };

const SPARSE_PAGE_CHAR_THRESHOLD = 40;

export function cleanText(text: string): string {
  return text
    .replace(/\x00/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractPdfWithReport(
  path: string,
  o: { maxBytes?: number; maxPages?: number } = {},
): Promise<{ pages: ExtractedPage[]; report: PdfExtractionReport }> {
  const maxBytes = o.maxBytes ?? 100 * 1024 * 1024;
  const maxPages = o.maxPages ?? 1000;

  let s;
  try {
    s = await stat(path);
  } catch {
    throw new AppError('PDF não encontrado.', { code: 'PDF_INVALID', stage: 'pdf_extraction' });
  }
  if (s.size > maxBytes) {
    throw new AppError('PDF excede o limite configurado.', {
      code: 'PDF_TOO_LARGE',
      stage: 'pdf_extraction',
    });
  }
  const data = await readFile(path);
  if (data.subarray(0, 5).toString() !== '%PDF-') {
    throw new AppError('Arquivo não é um PDF válido.', {
      code: 'PDF_INVALID',
      stage: 'pdf_extraction',
    });
  }

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: true,
  });

  try {
    let doc;
    try {
      doc = await loadingTask.promise;
    } catch (err) {
      throw new AppError('Falha ao processar a estrutura do PDF.', {
        code: 'PDF_INVALID',
        stage: 'pdf_extraction',
        cause: err,
      });
    }

    if (doc.numPages > maxPages) {
      throw new AppError('PDF excede o máximo configurado de páginas.', {
        code: 'PDF_PAGE_LIMIT',
        stage: 'pdf_extraction',
      });
    }

    const pages: ExtractedPage[] = [];
    const emptyPages: number[] = [];
    const sparsePages: number[] = [];
    const reportWarnings: string[] = [];
    let totalChars = 0;

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const str = content.items
        .map((item) => ('str' in item && typeof item.str === 'string' ? item.str : ''))
        .join(' ');
      const text = cleanText(str);
      const charCount = text.length;
      totalChars += charCount;

      let extractionQuality: 'good' | 'sparse' | 'empty' = 'good';
      const pageWarnings: string[] = [];

      if (charCount === 0) {
        extractionQuality = 'empty';
        emptyPages.push(i);
        pageWarnings.push(`Página ${i} sem camada de texto extraível.`);
      } else if (charCount < SPARSE_PAGE_CHAR_THRESHOLD) {
        extractionQuality = 'sparse';
        sparsePages.push(i);
        pageWarnings.push(`Página ${i} possui texto esparso (${charCount} caracteres).`);
      }

      pages.push(
        ExtractedPageSchema.parse({
          pageNumber: i,
          text,
          charCount,
          extractionQuality,
          warnings: pageWarnings,
        }),
      );
    }

    if (totalChars === 0) {
      throw new AppError('PDF não contém camada de texto; OCR é necessário.', {
        code: 'EMPTY_EXTRACTION',
        stage: 'pdf_extraction',
      });
    }

    if (emptyPages.length > 0) {
      reportWarnings.push(`Páginas vazias detectadas: ${emptyPages.join(', ')}`);
    }
    if (sparsePages.length > 0) {
      reportWarnings.push(`Páginas com texto esparso: ${sparsePages.join(', ')}`);
    }

    const report = PdfExtractionReportSchema.parse({
      pageCount: doc.numPages,
      totalChars,
      emptyPages,
      sparsePages,
      warnings: reportWarnings,
    });

    return { pages, report };
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

export async function extractPdf(
  path: string,
  o: { maxBytes?: number; maxPages?: number } = {},
): Promise<ExtractedPage[]> {
  const { pages } = await extractPdfWithReport(path, o);
  return pages;
}

export function getRange(pages: ExtractedPage[], start: number, end: number): string {
  if (start < 1 || end < start || end > pages.length) {
    throw new AppError(`Intervalo de páginas inválido: ${start}-${end}.`, {
      code: 'INVALID_INPUT',
      stage: 'pdf_extraction',
    });
  }
  return pages
    .slice(start - 1, end)
    .map((p) => `[Página ${p.pageNumber}]\n${p.text}`)
    .join('\n\n');
}
