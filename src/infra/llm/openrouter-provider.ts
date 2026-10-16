import { AppError } from '../../core/errors/app-error.js';
import { sanitizeMessage } from '../../core/logging/redact.js';
import type {
  LlmCallOptions,
  LlmProvider,
  LlmResult,
  LlmTaskType,
  LlmUsage,
} from '../../domain/ports/llm-provider.js';

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
  sleepImpl?: (ms: number) => Promise<void>;
  onUsage?: (event: {
    model: string;
    requestedModel: string;
    usage?: LlmUsage;
    elapsedMs: number;
    fallback: boolean;
  }) => void;
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
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function computeBackoffMs(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get('retry-after') ?? response?.headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds) && seconds > 0) {
      return Math.min(30000, Math.round(seconds * 1000));
    }
    const parsedDate = Date.parse(retryAfter);
    if (!Number.isNaN(parsedDate)) {
      const diff = parsedDate - Date.now();
      if (diff > 0) return Math.min(30000, diff);
    }
  }
  return Math.min(4000, 150 * Math.pow(2, attempt)) + Math.floor(Math.random() * 50);
}

type OpenRouterResponsePayload = {
  id?: string;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    total_cost?: number;
  };
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string; code?: number };
};

function parseUsage(raw?: OpenRouterResponsePayload['usage']): LlmUsage | undefined {
  if (!raw) return undefined;
  const usage: LlmUsage = {};
  if (typeof raw.prompt_tokens === 'number') usage.promptTokens = raw.prompt_tokens;
  if (typeof raw.completion_tokens === 'number') usage.completionTokens = raw.completion_tokens;
  if (typeof raw.total_tokens === 'number') usage.totalTokens = raw.total_tokens;
  const cost = typeof raw.cost === 'number' ? raw.cost : raw.total_cost;
  if (typeof cost === 'number' && cost >= 0) usage.estimatedCostUsd = cost;
  return Object.keys(usage).length > 0 ? usage : undefined;
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
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly onUsage?: OpenRouterOptions['onUsage'];

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
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (options.onUsage !== undefined) {
      this.onUsage = options.onUsage;
    }
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

  private async requestChatCompletion(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    task: LlmTaskType,
    options?: LlmCallOptions,
  ): Promise<Response> {
    const responseFormat = options?.jsonSchema
      ? {
          type: 'json_schema',
          json_schema: {
            name: options.schemaName ?? 'structured_output',
            strict: true,
            schema: options.jsonSchema,
          },
        }
      : { type: 'json_object' };

    return this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': this.appUrl,
        'X-Title': this.appTitle,
      },
      body: JSON.stringify({
        model,
        models: [model],
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: responseFormat,
        temperature: task === 'script' ? 0.6 : 0.2,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  async generateStructuredWithMeta<T>(
    prompt: string,
    schema: { parse(value: unknown): T },
    options?: LlmCallOptions,
  ): Promise<LlmResult<T>> {
    const task = options?.task ?? 'summary';
    const primaryModel = this.selectModelForTask(task);
    const candidateModels = [
      ...new Set([primaryModel, ...this.fallbackModels].map((m) => m.trim()).filter(Boolean)),
    ];
    const systemPrompt =
      options?.systemPrompt ??
      'Você é um especialista editorial e audiovisual. Responda ESTRITAMENTE com um único objeto JSON válido, sem blocos markdown adicionais.';

    let lastError: unknown;
    let totalAttempts = 0;

    for (let modelIdx = 0; modelIdx < candidateModels.length; modelIdx++) {
      const model = candidateModels[modelIdx]!;
      const isFallbackModel = modelIdx > 0;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        totalAttempts++;
        const startedAt = Date.now();
        try {
          const response = await this.requestChatCompletion(
            model,
            systemPrompt,
            prompt,
            task,
            options,
          );

          if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            const safeDetail = sanitizeMessage(errBody || response.statusText, [this.apiKey], 400);

            if (response.status === 401 || response.status === 403) {
              throw new AppError(
                `Autenticação recusada pelo OpenRouter (${response.status}): ${safeDetail}`,
                { code: 'LLM_AUTH', stage: 'llm', retryable: false },
              );
            }

            if (response.status === 402) {
              lastError = new Error(`Créditos insuficientes para [${model}]: ${safeDetail}`);
              break;
            }

            if (isRetryableStatus(response.status) && attempt < this.maxRetries) {
              await this.sleepImpl(computeBackoffMs(response, attempt));
              continue;
            }

            lastError = new Error(`HTTP ${response.status} em [${model}]: ${safeDetail}`);
            break;
          }

          const payload = (await response.json()) as OpenRouterResponsePayload;
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
          try {
            const parsed = schema.parse(json);
            const usedModel = payload.model || model;
            const usage = parseUsage(payload.usage);
            const elapsedMs = Date.now() - startedAt;
            this.onUsage?.({
              model: usedModel,
              requestedModel: primaryModel,
              ...(usage !== undefined ? { usage } : {}),
              elapsedMs,
              fallback: isFallbackModel || usedModel !== primaryModel,
            });

            return {
              data: parsed,
              requestedModel: primaryModel,
              usedModel,
              attempts: totalAttempts,
              ...(usage !== undefined ? { usage } : {}),
              ...(payload.id !== undefined ? { generationId: payload.id } : {}),
              degraded: isFallbackModel || usedModel !== primaryModel,
            };
          } catch (schemaErr: unknown) {
            // Syntactically valid JSON that failed schema contract: at most 1 repair attempt on this model
            const errSummary = sanitizeMessage(
              schemaErr instanceof Error ? schemaErr.message : String(schemaErr),
              [this.apiKey],
              600,
            );
            const repairPrompt = `${prompt}\n\nATENÇÃO: Sua resposta JSON anterior falhou na validação de contrato com o seguinte erro:\n${errSummary}\nCorrija os tipos e campos ausentes e retorne APENAS o objeto JSON corrigido.`;
            totalAttempts++;
            const repairResp = await this.requestChatCompletion(
              model,
              systemPrompt,
              repairPrompt,
              task,
              options,
            );
            if (repairResp.ok) {
              const repairPayload = (await repairResp.json()) as OpenRouterResponsePayload;
              const repairContent = repairPayload.choices?.[0]?.message?.content;
              if (repairContent?.trim()) {
                const repairedJson = extractJsonPayload(repairContent);
                const parsedRepair = schema.parse(repairedJson);
                const usedModel = repairPayload.model || model;
                const usage = parseUsage(repairPayload.usage) ?? parseUsage(payload.usage);
                const elapsedMs = Date.now() - startedAt;
                this.onUsage?.({
                  model: usedModel,
                  requestedModel: primaryModel,
                  ...(usage !== undefined ? { usage } : {}),
                  elapsedMs,
                  fallback: isFallbackModel || usedModel !== primaryModel,
                });
                return {
                  data: parsedRepair,
                  requestedModel: primaryModel,
                  usedModel,
                  attempts: totalAttempts,
                  ...(usage !== undefined ? { usage } : {}),
                  ...(repairPayload.id !== undefined ? { generationId: repairPayload.id } : {}),
                  degraded: isFallbackModel || usedModel !== primaryModel,
                };
              }
            }
            lastError = new AppError(`Resposta fora do schema em [${model}]: ${errSummary}`, {
              code: 'LLM_SCHEMA_INVALID',
              stage: 'llm',
              cause: schemaErr,
              retryable: false,
            });
            break;
          }
        } catch (err: unknown) {
          if (err instanceof AppError && !err.retryable) {
            throw err;
          }
          lastError = err;
          if (attempt < this.maxRetries) {
            await this.sleepImpl(computeBackoffMs(undefined, attempt));
          }
        }
      }
    }

    const rawMsg = lastError instanceof Error ? lastError.message : String(lastError);
    const safeMsg = sanitizeMessage(rawMsg, [this.apiKey]);
    throw new AppError(`Falha na chamada ao OpenRouter (${primaryModel}): ${safeMsg}`, {
      code:
        lastError instanceof AppError && lastError.code === 'LLM_SCHEMA_INVALID'
          ? 'LLM_SCHEMA_INVALID'
          : 'LLM_INVALID_OUTPUT',
      stage: 'llm',
      cause: lastError,
      retryable: true,
    });
  }

  async generateStructured<T>(
    prompt: string,
    schema: { parse(value: unknown): T },
    options?: LlmCallOptions,
  ): Promise<T> {
    const result = await this.generateStructuredWithMeta(prompt, schema, options);
    return result.data;
  }
}
