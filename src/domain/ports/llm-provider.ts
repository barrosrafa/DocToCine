export interface LlmProvider {
  generateStructured<T>(prompt: string, schema: { parse(value: unknown): T }): Promise<T>;
}
