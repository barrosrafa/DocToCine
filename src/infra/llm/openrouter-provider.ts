import { AppError } from '../../core/errors/app-error.js';
import { sanitizeMessage } from '../../core/logging/redact.js';
import type { LlmCallOptions, LlmProvider, LlmTaskType } from '../../domain/ports/llm-provider.js';

const OPENROUTER_MAX_MODELS_PER_REQUEST = 3;

export type OpenRouterOptions = {
  apiKey: string;
  baseUrl?: string;
  appUrl?: string;
  appTitle?: string;
  summaryModel?: string;
  scriptModel?: string;
  storyboardModel?: string;
  fallbackModels?: string[];
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
};

export function buildModelBatches(primaryModel: string, fallbacks: string[] = []): string[][] {
  const unique = [...new Set([primaryModel, ...fallbacks].map((m) => m.trim()).filter(Boolean))];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += OPENROUTER_MAX_MODELS_PER_REQUEST) {
    batches.push(unique.slice(i, i + OPENROUTER_MAX_MODELS_PER_REQUEST));
  }
  return batches.length ? batches : [[primaryModel]];
}

export function extractJsonPayload(raw: string): unknown {
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  try {
    return JSON.parse(withoutThink);
  } catch {
    // Try fenced code block
  }

  const fenceMatch = withoutThink.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // Continue to balanced brace extraction
    }
  }

  const firstBrace = withoutThink.indexOf('{');
  const lastBrace = withoutThink.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = withoutThink.slice(firstBrace, lastBrace + 1);
    return JSON.parse(candidate);
  }

  throw new Error('Nenhum objeto JSON válido encontrado na resposta do modelo.');
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 402 ||
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export class OpenRouterLlmProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly appUrl: string;
  private readonly appTitle: string;
  private readonly summaryModel: string;
  private readonly scriptModel: string;
  private readonly storyboardModel: string;
  private readonly fallbackModels: string[];
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenRouterOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.appUrl = options.appUrl ?? 'https://github.com/doctocine/lcbooks';
    this.appTitle = options.appTitle ?? 'DocToCine Pipeline';
    this.summaryModel = options.summaryModel ?? 'google/gemini-3.5-flash-lite';
    this.scriptModel = options.scriptModel ?? 'anthropic/claude-haiku-5.5';
    this.storyboardModel = options.storyboardModel ?? 'google/gemini-3.5-flash-lite';
    this.fallbackModels = options.fallbackModels ?? [
      'nvidia/nemotron-3-super-120b-a12b:free',
      'dots-studio/dots-3-note-preview:free',
      'liquid/lfm-2.5-2.6b:free',
      'openrouter/free',
    ];
    this.timeoutMs = options.timeoutMs ?? 45000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  selectModelForTask(task: LlmTaskType = 'summary'): string {
    switch (task) {
      case 'script':
        return this.scriptModel;
      case 'storyboard':
        return this.storyboardModel;
      case 'summary':
      default:
        return this.summaryModel;
    }
  }

  async generateStructured<T>(
    prompt: string,
    schema: { parse(value: unknown): T },
    options?: LlmCallOptions,
  ): Promise<T> {
    const task = options?.task ?? 'summary';
    const primaryModel = this.selectModelForTask(task);
    const batches = buildModelBatches(primaryModel, this.fallbackModels);
    const systemPrompt =
      options?.systemPrompt ??
      'Você é um especialista editorial e audiovisual. Responda ESTRITAMENTE com um único objeto JSON válido, sem blocos markdown adicionais.';

    let lastError: unknown;

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const models = batches[batchIdx]!;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': this.appUrl,
              'X-Title': this.appTitle,
            },
            body: JSON.stringify({
              models,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt },
              ],
              response_format: { type: 'json_object' },
              temperature: task === 'script' ? 0.6 : 0.2,
            }),
            signal: AbortSignal.timeout(this.timeoutMs),
          });

          if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            const safeDetail = sanitizeMessage(errBody || response.statusText, [this.apiKey], 400);

            if (response.status === 401 || response.status === 403) {
              throw new AppError(
                `Autenticação recusada pelo OpenRouter (${response.status}): ${safeDetail}`,
                { code: 'LLM_AUTH', stage: 'llm', retryable: false },
              );
            }

            // If 402 (insufficient credits for paid model in batch), jump immediately to next batch (free models)
            if (response.status === 402) {
              lastError = new Error(
                `Créditos insuficientes para [${models.join(', ')}]: ${safeDetail}`,
              );
              break;
            }

            if (isRetryableStatus(response.status) && attempt < this.maxRetries) {
              const backoffMs = Math.min(2000, 150 * Math.pow(2, attempt)) + Math.random() * 50;
              await new Promise((r) => setTimeout(r, backoffMs));
              continue;
            }

            lastError = new Error(
              `HTTP ${response.status} em [${models.join(', ')}]: ${safeDetail}`,
            );
            break;
          }

          const payload = (await response.json()) as {
            choices?: { message?: { content?: string | null } }[];
            error?: { message?: string; code?: number };
          };

          if (payload.error) {
            lastError = new Error(
              sanitizeMessage(payload.error.message ?? 'Erro interno OpenRouter', [this.apiKey]),
            );
            break;
          }

          const content = payload.choices?.[0]?.message?.content;
          if (!content || !content.trim()) {
            throw new AppError('OpenRouter retornou resposta vazia.', {
              code: 'LLM_INVALID_OUTPUT',
              stage: 'llm',
              retryable: true,
            });
          }

          const json = extractJsonPayload(content);
          return schema.parse(json);
        } catch (err: unknown) {
          if (err instanceof AppError && !err.retryable) {
            throw err;
          }
          lastError = err;
          if (attempt < this.maxRetries) {
            const backoffMs = Math.min(1000, 100 * Math.pow(2, attempt));
            await new Promise((r) => setTimeout(r, backoffMs));
          }
        }
      }
    }

    const rawMsg = lastError instanceof Error ? lastError.message : String(lastError);
    const safeMsg = sanitizeMessage(rawMsg, [this.apiKey]);
    throw new AppError(`Falha na chamada ao OpenRouter (${primaryModel}): ${safeMsg}`, {
      code: 'LLM_INVALID_OUTPUT',
      stage: 'llm',
      cause: lastError,
      retryable: true,
    });
  }
}
