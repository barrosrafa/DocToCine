import { z } from 'zod';

export const ExtractedPageSchema = z.object({
  pageNumber: z.number().int().positive(),
  text: z.string(),
  charCount: z.number().int().nonnegative(),
  extractionQuality: z.enum(['good', 'sparse', 'empty']).default('good'),
  warnings: z.array(z.string()).default([]),
});

export const PdfExtractionReportSchema = z.object({
  pageCount: z.number().int().nonnegative(),
  totalChars: z.number().int().nonnegative(),
  emptyPages: z.array(z.number().int().positive()).default([]),
  sparsePages: z.array(z.number().int().positive()).default([]),
  warnings: z.array(z.string()).default([]),
});

export type ExtractedPage = z.infer<typeof ExtractedPageSchema>;
export type PdfExtractionReport = z.infer<typeof PdfExtractionReportSchema>;
