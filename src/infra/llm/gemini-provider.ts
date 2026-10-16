import { GoogleGenAI } from '@google/genai';
import { AppError } from '../../core/errors/app-error.js';
import type { LlmProvider } from '../../domain/ports/llm-provider.js';

export class GeminiLlmProvider implements LlmProvider {
  private readonly ai: GoogleGenAI;

  constructor(
    apiKey: string,
    readonly model = 'gemini-3.5-flash-lite',
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generateStructured<T>(prompt: string, schema: { parse(value: unknown): T }): Promise<T> {
    try {
      const response = await this.ai.models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
        },
      });

      const text = response.text;
      if (!text) {
        throw new AppError('Gemini retornou resposta vazia.', {
          code: 'LLM_INVALID_OUTPUT',
          stage: 'llm',
        });
      }

      const json = JSON.parse(text) as unknown;
      return schema.parse(json);
    } catch (err: unknown) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        `Falha na chamada ao Gemini (${this.model}): ${err instanceof Error ? err.message : String(err)}`,
        {
          code: 'LLM_INVALID_OUTPUT',
          stage: 'llm',
          cause: err,
          retryable: true,
        },
      );
    }
  }
}
