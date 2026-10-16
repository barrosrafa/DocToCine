import { z } from 'zod';

export const ShotKindSchema = z.enum([
  'establishing',
  'character',
  'detail',
  'symbolic',
  'diagram',
  'quote-card',
  'transition',
  'recap',
]);
export type ShotKind = z.infer<typeof ShotKindSchema>;

export const CameraMoveSchema = z.enum([
  'static',
  'slow-zoom-in',
  'slow-zoom-out',
  'pan-left',
  'pan-right',
  'pan-up',
  'pan-down',
]);
export type CameraMove = z.infer<typeof CameraMoveSchema>;

export const VisualModeSchema = z.enum(['economic', 'balanced', 'dynamic']);
export type VisualMode = z.infer<typeof VisualModeSchema>;

export const AssetProvenanceSchema = z.enum(['ai', 'cache', 'sharp-fallback']);
export type AssetProvenance = z.infer<typeof AssetProvenanceSchema>;

export const StyleBibleSchema = z.object({
  version: z.string().default('v2.0'),
  palette: z.string().default('cinematic-amber-slate'),
  era: z.string().default('atemporal'),
  illustrationStyle: z
    .string()
    .default('Ilustração cinematográfica digital atmosférica de alta definição'),
  lighting: z.string().default('Iluminação dramática chiaroscuro e luz volumétrica suave'),
  aspectRatio: z.enum(['16:9', '9:16']).default('16:9'),
  negativeConstraints: z
    .string()
    .default('Sem textos, sem letras, sem legendas na arte, sem logotipos ou marcas d’água'),
});
export type StyleBible = z.infer<typeof StyleBibleSchema>;

export const PlannedShotSchema = z
  .object({
    shotId: z.string().min(1),
    sourceSegmentIds: z.array(z.string().min(1)).min(1),
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().positive(),
    visualPrompt: z.string().min(1).max(2500),
    onScreenText: z.string().max(160).default(''),
    kind: ShotKindSchema,
    cameraMove: CameraMoveSchema.default('slow-zoom-in'),
    assetKey: z.string().optional(),
    assetPath: z.string().optional(),
    provenance: AssetProvenanceSchema.optional(),
    generatedByAi: z.boolean().default(false),
    variantIndex: z.number().int().nonnegative().default(0),
    sourcePages: z.array(z.number().int().positive()).default([]),
  })
  .refine((s) => s.endSeconds > s.startSeconds, {
    message: 'endSeconds deve ser maior que startSeconds',
  });

export type PlannedShot = z.infer<typeof PlannedShotSchema>;

export const ShotPlanSchema = z.object({
  schemaVersion: z.literal(2).default(2),
  visualMode: VisualModeSchema.default('balanced'),
  styleBible: StyleBibleSchema,
  totalDurationSeconds: z.number().positive(),
  plannedAiImageCount: z.number().int().nonnegative(),
  shots: z.array(PlannedShotSchema).min(1),
  warnings: z.array(z.string()).default([]),
});

export type ShotPlan = z.infer<typeof ShotPlanSchema>;
