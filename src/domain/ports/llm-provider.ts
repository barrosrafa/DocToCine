export type LlmTaskType = 'summary' | 'script' | 'storyboard';

export type LlmCallOptions = {
  task?: LlmTaskType;
  systemPrompt?: string;
  schemaName?: string;
  jsonSchema?: Record<string, unknown>;
};

export type LlmUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
};

export type LlmResult<T> = {
  data: T;
  requestedModel: string;
  usedModel: string;
  attempts: number;
  usage?: LlmUsage;
  degraded: boolean;
  generationId?: string;
};

export interface LlmProvider {
  generateStructured<T>(
    prompt: string,
    schema: { parse(value: unknown): T },
    options?: LlmCallOptions,
  ): Promise<T>;
  generateStructuredWithMeta?<T>(
    prompt: string,
    schema: { parse(value: unknown): T },
    options?: LlmCallOptions,
  ): Promise<LlmResult<T>>;
}
