import { z } from 'zod';
export const ChapterBoundarySchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().trim().min(1).max(500),
    startPage: z.number().int().positive(),
    endPage: z.number().int().positive(),
    evidence: z.string().max(4000).default(''),
  })
  .refine((v) => v.endPage >= v.startPage, {
    message: 'A página final deve ser maior ou igual à inicial.',
    path: ['endPage'],
  });
export const ChapterMapSchema = z.object({
  chapters: z.array(ChapterBoundarySchema),
  notes: z.string().default(''),
  warnings: z.array(z.string()).default([]),
});
export const SupportedClaimSchema = z.object({
  claim: z.string().trim().min(1).max(8000),
  sourcePages: z.array(z.number().int().positive()).default([]),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
});
export const ChapterSummarySchema = z.object({
  title: z.string().default(''),
  thesis: z.string().default(''),
  keyPoints: z.array(z.string()).default([]),
  examples: z.array(z.string()).default([]),
  quotesOrDefinitions: z.array(z.string()).default([]),
  definitions: z.array(SupportedClaimSchema).default([]),
  supportedClaims: z.array(SupportedClaimSchema).default([]),
  sourcePages: z.array(z.number().int().positive()).default([]),
  audienceTakeaway: z.string().default(''),
  visualMotifs: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
});
export const ChapterPackageSchema = z.object({
  chapterNumber: z.number().int().positive(),
  chapterTitle: z.string(),
  pageRange: z.tuple([z.number(), z.number()]),
  summary: ChapterSummarySchema,
  scripts: z.array(z.unknown()).default([]),
  imageIdeas: z.array(z.string()).default([]),
});
export type ChapterBoundary = z.infer<typeof ChapterBoundarySchema>;
export type ChapterMap = z.infer<typeof ChapterMapSchema>;
export type SupportedClaim = z.infer<typeof SupportedClaimSchema>;
export type ChapterSummary = z.infer<typeof ChapterSummarySchema>;
export type ChapterPackage = z.infer<typeof ChapterPackageSchema>;
export function normalizeChapterSummary(input: unknown): ChapterSummary {
  const raw = input && typeof input === 'object' ? { ...(input as Record<string, unknown>) } : {};
  const claims = [...(Array.isArray(raw.supportedClaims) ? raw.supportedClaims : [])];
  for (const field of ['keyPoints', 'examples', 'quotesOrDefinitions', 'definitions'] as const) {
    const val = raw[field];
    if (Array.isArray(val)) {
      raw[field] = val.map((x) =>
        typeof x === 'string'
          ? x
          : x && typeof x === 'object' && 'claim' in x
            ? String((x as { claim: unknown }).claim)
            : String(x),
      );
      for (const x of val) if (x && typeof x === 'object' && 'claim' in x) claims.push(x);
    }
  }
  raw.supportedClaims = claims;
  const parsed = ChapterSummarySchema.parse(raw);
  const pages = new Set(parsed.sourcePages);
  for (const c of [...parsed.supportedClaims, ...parsed.definitions])
    for (const p of c.sourcePages) pages.add(p);
  return { ...parsed, sourcePages: [...pages].sort((a, b) => a - b) };
}
