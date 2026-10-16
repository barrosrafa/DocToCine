import { z } from 'zod';

export const SummaryRunStatusSchema = z.enum(['ai', 'partial', 'heuristic']);
export type SummaryRunStatus = z.infer<typeof SummaryRunStatusSchema>;

export const SupportedClaimSchema = z.object({
  claimId: z.string().min(1).default('claim_001'),
  claim: z.string().trim().min(1).max(8000),
  sourcePages: z.array(z.number().int().positive()).default([]),
  chunkIds: z.array(z.string().min(1)).default([]),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
});

export type SupportedClaim = z.infer<typeof SupportedClaimSchema>;
