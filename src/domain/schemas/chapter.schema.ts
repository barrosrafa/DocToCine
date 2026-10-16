import { z } from 'zod';
import {
  SupportedClaimSchema,
  SummaryRunStatusSchema,
  type SupportedClaim,
  type SummaryRunStatus,
} from './claims.schema.js';
import { VideoScriptSchema } from './script.schema.js';

export { SupportedClaimSchema, SummaryRunStatusSchema, type SupportedClaim, type SummaryRunStatus };

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

export const ChapterSummarySchema = z.object({
  schemaVersion: z.number().int().positive().default(2),
  status: SummaryRunStatusSchema.default('ai'),
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
  warnings: z.array(z.string()).default([]),
});

export const ChapterPackageSchema = z.object({
  schemaVersion: z.number().int().positive().default(2),
  chapterNumber: z.number().int().positive(),
  chapterTitle: z.string(),
  pageRange: z.tuple([z.number(), z.number()]),
  status: SummaryRunStatusSchema.default('ai'),
  degraded: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
  summary: ChapterSummarySchema,
  scripts: z.array(VideoScriptSchema).default([]),
  imageIdeas: z.array(z.string()).default([]),
});

export type ChapterBoundary = z.infer<typeof ChapterBoundarySchema>;
export type ChapterMap = z.infer<typeof ChapterMapSchema>;
export type ChapterSummary = z.infer<typeof ChapterSummarySchema>;
export type ChapterPackage = z.infer<typeof ChapterPackageSchema>;

export function normalizeChapterSummary(input: unknown): ChapterSummary {
  const raw = input && typeof input === 'object' ? { ...(input as Record<string, unknown>) } : {};
  const claims = [...(Array.isArray(raw.supportedClaims) ? raw.supportedClaims : [])];
  for (const field of ['keyPoints', 'examples', 'quotesOrDefinitions', 'definitions'] as const) {
    const val = raw[field];
    if (Array.isArray(val)) {
      if (field !== 'definitions') {
        raw[field] = val.map((x) =>
          typeof x === 'string'
            ? x
            : x && typeof x === 'object' && 'claim' in x
              ? String((x as { claim: unknown }).claim)
              : String(x),
        );
      } else {
        raw[field] = val.map((x, idx) =>
          typeof x === 'string'
            ? { claimId: `def_${idx + 1}`, claim: x, sourcePages: [], confidence: 'medium' }
            : x,
        );
      }
      for (const x of val) {
        if (x && typeof x === 'object' && 'claim' in x) {
          claims.push(x);
        }
      }
    }
  }
  raw.supportedClaims = claims.map((c, idx) =>
    c && typeof c === 'object'
      ? {
          claimId:
            'claimId' in c && typeof (c as { claimId: unknown }).claimId === 'string'
              ? (c as { claimId: string }).claimId
              : `claim_${String(idx + 1).padStart(3, '0')}`,
          ...(c as Record<string, unknown>),
        }
      : c,
  );
  const parsed = ChapterSummarySchema.parse(raw);
  const pages = new Set(parsed.sourcePages);
  for (const c of [...parsed.supportedClaims, ...parsed.definitions]) {
    for (const p of c.sourcePages) pages.add(p);
  }
  return { ...parsed, sourcePages: [...pages].sort((a, b) => a - b) };
}
