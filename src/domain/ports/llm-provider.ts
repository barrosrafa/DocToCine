export type LlmTaskType = 'summary' | 'script' | 'storyboard';

export type LlmCallOptions = {
  task?: LlmTaskType;
  systemPrompt?: string;
};

export interface LlmProvider {
  generateStructured<T>(
    prompt: string,
    schema: { parse(value: unknown): T },
    options?: LlmCallOptions,
  ): Promise<T>;
}
