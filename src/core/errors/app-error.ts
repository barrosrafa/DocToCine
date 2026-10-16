export type ErrorStage =
  | 'configuration'
  | 'pdf_extraction'
  | 'chapter_detection'
  | 'llm'
  | 'summary'
  | 'script_generation'
  | 'storyboard'
  | 'assets'
  | 'audio'
  | 'alignment'
  | 'captions'
  | 'rendering'
  | 'quality_check'
  | 'storage'
  | 'budget'
  | 'general';
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'PDF_TOO_LARGE'
  | 'PDF_INVALID'
  | 'PDF_PAGE_LIMIT'
  | 'EMPTY_EXTRACTION'
  | 'OCR_REQUIRED'
  | 'LLM_AUTH'
  | 'LLM_INVALID_OUTPUT'
  | 'LLM_SCHEMA_INVALID'
  | 'BUDGET_EXCEEDED'
  | 'TTS_FAILED'
  | 'TTS_UNAVAILABLE'
  | 'AUDIO_INVALID'
  | 'ALIGNMENT_FAILED'
  | 'IMAGE_GENERATION_FAILED'
  | 'FFMPEG_MISSING'
  | 'PROCESS_TIMEOUT'
  | 'ARTIFACT_INVALID'
  | 'VIDEO_QUALITY_FAILED'
  | 'UNEXPECTED';
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly stage: ErrorStage;
  readonly retryable: boolean;
  constructor(
    message: string,
    o: { code: ErrorCode; stage: ErrorStage; retryable?: boolean; cause?: unknown },
  ) {
    super(message, { cause: o.cause });
    this.name = 'AppError';
    this.code = o.code;
    this.stage = o.stage;
    this.retryable = o.retryable ?? false;
  }
}
export function asError(v: unknown): Error {
  return v instanceof Error
    ? v
    : new Error('Erro não padronizado recebido pela aplicação.', { cause: v });
}
