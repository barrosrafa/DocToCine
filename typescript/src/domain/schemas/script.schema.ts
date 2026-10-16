import { z } from 'zod';
export const DurationSchema = z.union([z.literal(1), z.literal(3), z.literal(20)]);
export const NarrationSegmentSchema = z.object({
  id: z.string().trim().min(1).max(80),
  text: z.string().trim().min(1).max(30000),
  sceneHint: z.string().max(2000).default(''),
  onScreenText: z.string().max(500).default(''),
  sourcePages: z.array(z.number().int().positive()).default([]),
});
export const VideoScriptSchema = z.object({
  title: z.string().default(''),
  durationMinutes: DurationSchema,
  targetAudience: z.string().default('Público geral e leitores'),
  hook: z.string().default(''),
  beats: z.array(z.string()).min(1),
  narration: z.string().trim().min(1),
  segments: z.array(NarrationSegmentSchema).default([]),
  cta: z.string().default(''),
  bRollAndVisuals: z.array(z.string()).default([]),
});
export type NarrationSegment = z.infer<typeof NarrationSegmentSchema>;
export type VideoScript = z.infer<typeof VideoScriptSchema>;
export function ensureScriptSegments(script: VideoScript, pages: number[] = []): VideoScript {
  if (script.segments.length)
    return {
      ...script,
      segments: script.segments.map((s, i) => ({
        ...s,
        id: `seg_${String(i + 1).padStart(4, '0')}`,
        sourcePages: s.sourcePages.length ? s.sourcePages : pages,
      })),
    };
  const paragraphs = script.narration
    .split(/\n\s*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    ...script,
    segments: paragraphs.map((text, i) => ({
      id: `seg_${String(i + 1).padStart(4, '0')}`,
      text,
      sceneHint: script.bRollAndVisuals[i % Math.max(script.bRollAndVisuals.length, 1)] ?? '',
      onScreenText: script.beats[i % script.beats.length] ?? '',
      sourcePages: pages,
    })),
  };
}
