import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import pLimit from 'p-limit';
import { AppError } from '../../core/errors/app-error.js';
import { sanitizeMessage } from '../../core/logging/redact.js';
import type {
  TimedSpeech,
  TtsProvider,
  TtsRequest,
  TtsSegmentResult,
  TtsSegmentsSynthesisResult,
} from '../../domain/ports/tts-provider.js';
import { probeAudioFile } from './audio-probe.js';
import { preprocessNarrationText } from '../../application/services/narration-preprocessor.js';

export type OpenRouterSpeechOptions = {
  apiKey: string;
  baseUrl?: string;
  appUrl?: string;
  appTitle?: string;
  model: string;
  voice: string;
  speed?: number;
  responseFormat?: 'mp3' | 'pcm';
  timeoutMs?: number;
  maxRetries?: number;
  maxParallelRequests?: number;
  styleInstructions?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  onUsage?: (event: {
    model: string;
    inputCharacters: number;
    outputBytes: number;
    elapsedMs: number;
    generationId?: string;
  }) => void;
};

function isTransientStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export class OpenRouterSpeechProvider implements TtsProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly appUrl: string;
  private readonly appTitle: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly speed: number;
  private readonly responseFormat: 'mp3' | 'pcm';
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxParallelRequests: number;
  private readonly styleInstructions?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly onUsage?: OpenRouterSpeechOptions['onUsage'];

  constructor(options: OpenRouterSpeechOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.appUrl = options.appUrl ?? 'https://github.com/barrosrafa/DocToCine';
    this.appTitle = options.appTitle ?? 'DocToCine';
    this.model = options.model;
    this.voice = options.voice;
    this.speed = options.speed ?? 1.0;
    this.responseFormat = options.responseFormat ?? 'mp3';
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.maxRetries = options.maxRetries ?? 2;
    this.maxParallelRequests = options.maxParallelRequests ?? 2;
    if (options.styleInstructions !== undefined) {
      this.styleInstructions = options.styleInstructions;
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (options.onUsage !== undefined) {
      this.onUsage = options.onUsage;
    }
  }

  async synthesizeRequest(req: TtsRequest): Promise<TtsSegmentResult> {
    const cleanText = req.text.trim();
    if (!cleanText) {
      throw new AppError('TTS recebeu texto vazio.', {
        code: 'INVALID_INPUT',
        stage: 'audio',
        retryable: false,
      });
    }

    await mkdir(dirname(req.outputPath), { recursive: true });
    const tmp = `${req.outputPath}.partial`;
    const voice = req.voice || this.voice;
    const speed = req.speed ?? this.speed;
    const instructions = req.styleInstructions ?? this.styleInstructions;

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const startedAt = Date.now();
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/audio/speech`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': this.appUrl,
            'X-OpenRouter-Title': this.appTitle,
          },
          body: JSON.stringify({
            model: this.model,
            input: cleanText,
            voice,
            response_format: this.responseFormat,
            speed,
            ...(instructions
              ? {
                  provider: { options: { openai: { instructions } } },
                }
              : {}),
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!response.ok) {
          const rawDetail = await response.text().catch(() => '');
          const safeDetail = sanitizeMessage(rawDetail || response.statusText, [this.apiKey], 600);

          if (response.status === 401 || response.status === 403) {
            throw new AppError(`TTS HTTP ${response.status} (Auth): ${safeDetail}`, {
              code: 'LLM_AUTH',
              stage: 'audio',
              retryable: false,
            });
          }

          if (isTransientStatus(response.status) && attempt < this.maxRetries) {
            const backoff = Math.min(3000, 200 * Math.pow(2, attempt));
            await this.sleepImpl(backoff);
            continue;
          }

          throw new AppError(`TTS HTTP ${response.status}: ${safeDetail}`, {
            code: 'TTS_FAILED',
            stage: 'audio',
            retryable: isTransientStatus(response.status),
          });
        }

        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength < 512) {
          throw new AppError(`TTS retornou arquivo muito pequeno (${bytes.byteLength} bytes).`, {
            code: 'AUDIO_INVALID',
            stage: 'audio',
            retryable: true,
          });
        }

        try {
          await writeFile(tmp, bytes);
          const probe = await probeAudioFile(tmp, { minBytes: 512 });
          await rename(tmp, req.outputPath);

          const generationId = response.headers.get('x-generation-id') ?? undefined;
          const elapsedMs = Date.now() - startedAt;
          this.onUsage?.({
            model: this.model,
            inputCharacters: cleanText.length,
            outputBytes: bytes.byteLength,
            elapsedMs,
            ...(generationId !== undefined ? { generationId } : {}),
          });

          return {
            segmentId: req.idempotencyKey,
            path: req.outputPath,
            durationSeconds: probe.durationSeconds,
            provider: 'openrouter-speech',
            model: this.model,
            voice,
            bytes: bytes.byteLength,
            ...(generationId !== undefined ? { generationId } : {}),
            degraded: false,
          };
        } catch (err) {
          await unlink(tmp).catch(() => {});
          throw err;
        }
      } catch (err: unknown) {
        if (err instanceof AppError && !err.retryable) {
          throw err;
        }
        lastError = err;
        if (attempt < this.maxRetries) {
          await this.sleepImpl(Math.min(2000, 150 * Math.pow(2, attempt)));
        }
      }
    }

    const rawMsg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new AppError(
      `Falha ao sintetizar áudio em ${this.model}: ${sanitizeMessage(rawMsg, [this.apiKey])}`,
      {
        code: 'TTS_FAILED',
        stage: 'audio',
        cause: lastError,
        retryable: true,
      },
    );
  }

  async synthesize(
    text: string,
    path: string,
  ): Promise<{
    path: string;
    duration: number;
    degraded?: boolean;
    model?: string;
    voice?: string;
  }> {
    const processed = preprocessNarrationText(text);
    const res = await this.synthesizeRequest({
      text: processed.spokenText,
      outputPath: path,
      language: 'pt-BR',
      voice: this.voice,
      speed: this.speed,
      idempotencyKey: path,
    });
    return {
      path: res.path,
      duration: res.durationSeconds,
      degraded: res.degraded,
      model: res.model,
      voice: res.voice,
    };
  }

  async synthesizeSegments(
    segments: { id: string; text: string }[],
    dir: string,
  ): Promise<TtsSegmentsSynthesisResult> {
    const limit = pLimit(Math.max(1, this.maxParallelRequests));
    const results = await Promise.all(
      segments.map((s) =>
        limit(async () => {
          const outPath = join(dir, `${s.id}.mp3`);
          const processed = preprocessNarrationText(s.text);
          const r = await this.synthesizeRequest({
            text: processed.spokenText,
            outputPath: outPath,
            language: 'pt-BR',
            voice: this.voice,
            speed: this.speed,
            idempotencyKey: s.id,
          });
          return { segment: s, spokenText: processed.spokenText, result: r };
        }),
      ),
    );

    let cursor = 0;
    const timed: TimedSpeech[] = [];
    const usedModels = new Set<string>();

    for (const item of results) {
      usedModels.add(item.result.model);
      timed.push({
        segmentId: item.segment.id,
        text: item.segment.text,
        spokenText: item.spokenText,
        startSeconds: cursor,
        endSeconds: cursor + item.result.durationSeconds,
        path: item.result.path,
        model: item.result.model,
        voice: item.result.voice,
        degraded: item.result.degraded,
      });
      cursor += item.result.durationSeconds;
    }

    return {
      timed,
      duration: cursor,
      degraded: false,
      usedModels: [...usedModels],
      warnings: [],
    };
  }
}
