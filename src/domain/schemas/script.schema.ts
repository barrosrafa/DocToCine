import { z } from 'zod';
import { SupportedClaimSchema } from './claims.schema.js';

export const DurationSchema = z.union([z.literal(1), z.literal(3), z.literal(20)]);

export const ToneSchema = z.enum(['documental', 'cinematografico', 'educativo', 'conversacional']);
export type ScriptTone = z.infer<typeof ToneSchema>;

export const NarrationSegmentSchema = z.object({
  id: z.string().trim().min(1).max(80),
  text: z.string().trim().min(1).max(30000),
  sceneHint: z.string().max(2000).default(''),
  onScreenText: z.string().max(500).default(''),
  sourcePages: z.array(z.number().int().positive()).default([]),
});

export const VideoScriptSchema = z.object({
  schemaVersion: z.number().int().positive().default(2),
  title: z.string().trim().max(300).default(''),
  durationMinutes: DurationSchema,
  language: z.literal('pt-BR').default('pt-BR'),
  targetAudience: z.string().default('Público geral e leitores'),
  tone: ToneSchema.default('cinematografico'),
  hook: z.string().default(''),
  beats: z.array(z.string().trim().min(1)).min(1).max(20),
  narration: z.string().trim().min(1),
  segments: z.array(NarrationSegmentSchema).default([]),
  cta: z.string().default(''),
  bRollAndVisuals: z.array(z.string()).default([]),
  sourcePages: z.array(z.number().int().positive()).default([]),
  claims: z.array(SupportedClaimSchema).default([]),
  degraded: z.boolean().default(false),
  usedModel: z.string().optional(),
  warnings: z.array(z.string()).default([]),
});

export type NarrationSegment = z.infer<typeof NarrationSegmentSchema>;
export type VideoScript = z.infer<typeof VideoScriptSchema>;

export function ensureScriptSegments(
  script: VideoScript,
  pages: number[] = [],
  claims: z.infer<typeof SupportedClaimSchema>[] = [],
): VideoScript {
  const resolvedPages = script.sourcePages.length > 0 ? script.sourcePages : pages;
  const resolvedClaims = script.claims.length > 0 ? script.claims : claims;

  if (script.segments.length) {
    return {
      ...script,
      sourcePages: resolvedPages,
      claims: resolvedClaims,
      segments: script.segments.map((s, i) => ({
        ...s,
        id: `seg_${String(i + 1).padStart(4, '0')}`,
        sourcePages: s.sourcePages.length ? s.sourcePages : resolvedPages,
      })),
    };
  }

  const paragraphs = script.narration
    .split(/\n\s*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    ...script,
    sourcePages: resolvedPages,
    claims: resolvedClaims,
    segments: paragraphs.map((text, i) => ({
      id: `seg_${String(i + 1).padStart(4, '0')}`,
      text,
      sceneHint: script.bRollAndVisuals[i % Math.max(script.bRollAndVisuals.length, 1)] ?? '',
      onScreenText: script.beats[i % script.beats.length] ?? '',
      sourcePages: resolvedPages,
    })),
  };
}
