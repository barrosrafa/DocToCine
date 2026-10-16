export type TimedSpeech = {
  segmentId: string;
  text: string;
  spokenText?: string;
  startSeconds: number;
  endSeconds: number;
  path?: string;
  model?: string;
  voice?: string;
  degraded?: boolean;
};

export type TtsRequest = {
  text: string;
  outputPath: string;
  language: 'pt-BR' | string;
  voice: string;
  speed: number;
  styleInstructions?: string;
  idempotencyKey: string;
};

export type TtsSegmentResult = {
  segmentId: string;
  path: string;
  durationSeconds: number;
  provider: string;
  model: string;
  voice: string;
  bytes: number;
  generationId?: string;
  degraded: boolean;
  fallbackReason?: string;
};

export type TtsSegmentsSynthesisResult = {
  timed: TimedSpeech[];
  duration: number;
  degraded?: boolean;
  usedModels?: string[];
  warnings?: string[];
};

export interface TtsProvider {
  synthesize(
    text: string,
    path: string,
  ): Promise<{
    path: string;
    duration: number;
    degraded?: boolean;
    model?: string;
    voice?: string;
  }>;
  synthesizeRequest?(request: TtsRequest): Promise<TtsSegmentResult>;
  synthesizeSegments(
    segments: { id: string; text: string }[],
    dir: string,
  ): Promise<TtsSegmentsSynthesisResult>;
}
