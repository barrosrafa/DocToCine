export type TimedSpeech = {
  segmentId: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export interface TtsProvider {
  synthesize(text: string, path: string): Promise<{ path: string; duration: number }>;
  synthesizeSegments(
    segments: { id: string; text: string }[],
    dir: string,
  ): Promise<{ timed: TimedSpeech[]; duration: number }>;
}
