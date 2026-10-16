import { z } from 'zod';
import { VisualModeSchema } from './scene.schema.js';

export const StageStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'degraded',
  'failed',
  'skipped',
]);

export type StageStatus = z.infer<typeof StageStatusSchema>;

export const JobStageSchema = z.object({
  name: z.string().min(1),
  status: StageStatusSchema,
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  attempts: z.number().int().nonnegative().default(0),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
});

export type JobStage = z.infer<typeof JobStageSchema>;

export const JobManifestSchema = z.object({
  schemaVersion: z.number().int().positive().default(2),
  jobId: z.string().min(1).default('job_default'),
  inputHash: z.string().default(''),
  status: StageStatusSchema,
  chapters: z.number().int().nonnegative().default(0),
  stages: z.array(JobStageSchema).default([]),
  degraded: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
});

export type JobManifest = z.infer<typeof JobManifestSchema>;

export const RunOptionsSchema = z.object({
  resume: z.boolean().default(false),
  force: z.boolean().default(false),
  continueOnError: z.boolean().default(true),
  verbose: z.boolean().default(false),
  aspectRatio: z.enum(['16:9', '9:16']).default('16:9'),
  visualMode: VisualModeSchema.default('balanced'),
  voice: z.string().trim().min(1).optional(),
  burnCaptions: z.boolean().default(true),
  maxCostUsd: z.number().nonnegative().optional(),
});

export type RunOptions = z.infer<typeof RunOptionsSchema>;
