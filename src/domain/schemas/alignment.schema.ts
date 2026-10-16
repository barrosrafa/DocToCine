import { z } from 'zod';

export const WordTimingSchema = z
  .object({
    text: z.string().min(1),
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().positive(),
    confidence: z.number().min(0).max(1).optional(),
    segmentId: z.string().optional(),
  })
  .refine((v) => v.endSeconds > v.startSeconds, {
    message: 'endSeconds deve ser maior que startSeconds',
  });

export const AlignmentMethodSchema = z.enum(['forced-alignment', 'phrase-estimate']);
export type AlignmentMethod = z.infer<typeof AlignmentMethodSchema>;

export const AlignmentResultSchema = z.object({
  words: z.array(WordTimingSchema),
  method: AlignmentMethodSchema,
  warnings: z.array(z.string()).default([]),
});

export type WordTiming = z.infer<typeof WordTimingSchema>;
export type AlignmentResult = z.infer<typeof AlignmentResultSchema>;
