import type { AlignmentResult } from '../schemas/alignment.schema.js';

export type AlignSegmentInput = {
  segmentId?: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export interface AlignmentProvider {
  align(input: {
    audioPath: string;
    transcript: string;
    language: 'pt';
    durationSeconds?: number;
  }): Promise<AlignmentResult>;
  alignSegments?(segments: AlignSegmentInput[]): Promise<AlignmentResult>;
}
