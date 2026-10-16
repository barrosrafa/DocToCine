import { z } from 'zod';

export const CostStatusSchema = z.enum(['measured', 'estimated', 'unknown']);
export type CostStatus = z.infer<typeof CostStatusSchema>;

export const UsageEventSchema = z.object({
  jobId: z.string(),
  stage: z.string(),
  model: z.string().optional(),
  requestCount: z.number().int().positive().default(1),
  promptTokens: z.number().nonnegative().optional(),
  completionTokens: z.number().nonnegative().optional(),
  inputCharacters: z.number().nonnegative().optional(),
  outputBytes: z.number().nonnegative().optional(),
  measuredCostUsd: z.number().nonnegative().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  costStatus: CostStatusSchema,
  elapsedMs: z.number().nonnegative(),
  fallback: z.boolean().default(false),
});

export type UsageEvent = z.infer<typeof UsageEventSchema>;

export const UsageReportSchema = z.object({
  schemaVersion: z.literal(2).default(2),
  jobId: z.string(),
  currency: z.literal('USD').default('USD'),
  observedCostUsd: z.number().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  totalKnownCostUsd: z.number().nonnegative(),
  unknownCostCount: z.number().int().nonnegative(),
  events: z.array(UsageEventSchema).default([]),
});

export type UsageReport = z.infer<typeof UsageReportSchema>;
