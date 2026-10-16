import { z } from 'zod';
import { AlignmentMethodSchema } from './alignment.schema.js';

export const VideoStatusSchema = z.enum([
  'pending',
  'script_ready',
  'storyboard_ready',
  'assets_ready',
  'audio_ready',
  'captions_ready',
  'rendering',
  'rendered',
  'quality_checked',
  'completed',
  'failed',
]);

export type VideoStatus = z.infer<typeof VideoStatusSchema>;

export const StoryboardSceneSchema = z.object({
  sceneId: z.string(),
  segmentIds: z.array(z.string()).min(1),
  visualPrompt: z.string().default(''),
  onScreenText: z.string().default(''),
  assetPath: z.string().optional(),
  durationSeconds: z.number().positive().default(5),
  sourcePages: z.array(z.number().int().positive()).default([]),
});

export const QualityReportSchema = z.object({
  schemaVersion: z.number().int().positive().default(2),
  passed: z.boolean().default(false),
  videoCodec: z.string().default(''),
  audioCodec: z.string().default(''),
  pixFmt: z.string().default(''),
  width: z.number().default(0),
  height: z.number().default(0),
  fps: z.number().default(0),
  sampleRate: z.number().default(0),
  channels: z.number().default(0),
  fileSizeBytes: z.number().nonnegative().default(0),
  durationSeconds: z.number().default(0),
  videoDurationSeconds: z.number().default(0),
  audioDurationSeconds: z.number().default(0),
  expectedDurationSeconds: z.number().optional(),
  durationDeltaSeconds: z.number().default(0),
  hasAudio: z.boolean().default(false),
  captionsPresent: z.boolean().default(false),
  captionFileValid: z.boolean().default(true),
  captionLastEndSeconds: z.number().default(0),
  captionOverlapCount: z.number().int().nonnegative().default(0),
  alignmentMethod: AlignmentMethodSchema.optional(),
  ttsDegraded: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
});

export const VideoManifestSchema = z.object({
  schemaVersion: z.number().int().positive().default(2),
  status: VideoStatusSchema.default('pending'),
  degraded: z.boolean().default(false),
  storyboardPath: z.string().optional(),
  shotPlanPath: z.string().optional(),
  narrationPath: z.string().optional(),
  alignmentPath: z.string().optional(),
  captionsPath: z.string().optional(),
  assCaptionsPath: z.string().optional(),
  videoPath: z.string().optional(),
  qualityReportPath: z.string().optional(),
  durationSeconds: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  fps: z.number().optional(),
  shotCount: z.number().int().nonnegative().optional(),
  newImageCount: z.number().int().nonnegative().optional(),
  alignmentMethod: AlignmentMethodSchema.optional(),
  attempts: z.number().int().default(0),
  failedStage: z.string().optional(),
  errorMessage: z.string().optional(),
  retryable: z.boolean().default(false),
  scriptHash: z.string().optional(),
  configHash: z.string().optional(),
  promptVersion: z.string().optional(),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
});

export type StoryboardScene = z.infer<typeof StoryboardSceneSchema>;
export type QualityReport = z.infer<typeof QualityReportSchema>;
export type VideoManifest = z.infer<typeof VideoManifestSchema>;

const transitions: Record<VideoStatus, VideoStatus[]> = {
  pending: ['script_ready', 'audio_ready', 'failed'],
  script_ready: ['storyboard_ready', 'audio_ready', 'failed'],
  storyboard_ready: ['assets_ready', 'failed'],
  assets_ready: ['audio_ready', 'rendering', 'failed'],
  audio_ready: ['captions_ready', 'storyboard_ready', 'failed'],
  captions_ready: ['storyboard_ready', 'assets_ready', 'rendering', 'failed'],
  rendering: ['rendered', 'failed'],
  rendered: ['quality_checked', 'failed'],
  quality_checked: ['completed', 'failed'],
  completed: [],
  failed: ['storyboard_ready', 'audio_ready', 'pending'],
};

export function canTransition(from: VideoStatus, to: VideoStatus) {
  return from === to || transitions[from].includes(to);
}

export function transition(m: VideoManifest, to: VideoStatus): VideoManifest {
  if (!canTransition(m.status, to)) throw new Error(`Transição inválida: ${m.status} -> ${to}`);
  return { ...m, status: to };
}
