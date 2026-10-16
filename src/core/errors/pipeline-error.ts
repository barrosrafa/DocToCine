export type PipelineStage =
  'pdf' | 'summary' | 'script' | 'tts' | 'alignment' | 'image' | 'render' | 'quality' | 'budget';

export class PipelineError extends Error {
  constructor(
    message: string,
    readonly stage: PipelineStage,
    readonly code: string,
    readonly retryable: boolean,
    readonly degradedAllowed = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PipelineError';
  }
}
