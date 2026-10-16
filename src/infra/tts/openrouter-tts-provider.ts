import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import type { TimedSpeech, TtsProvider } from '../../domain/ports/tts-provider.js';
import { FakeTtsProvider } from './fake-tts-provider.js';

export type OpenRouterTtsOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  fallbackProvider?: TtsProvider;
};

function probeDurationSeconds(path: string): Promise<number | null> {
  return new Promise((res) => {
    const p = spawn(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        path,
      ],
      { shell: false, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += String(d)));
    p.on('error', () => res(null));
    p.on('close', (code) => {
      if (code !== 0) return res(null);
      const parsed = parseFloat(stdout.trim());
      res(!isNaN(parsed) && parsed > 0 ? parsed : null);
    });
  });
}

export class OpenRouterTtsProvider implements TtsProvider {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly fallback: TtsProvider;

  constructor(options: OpenRouterTtsOptions = {}) {
    if (options.apiKey !== undefined) {
      this.apiKey = options.apiKey;
    }
    this.baseUrl = (options.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.model = options.model ?? 'openai/gpt-audio-mini';
    this.voice = options.voice ?? 'nova';
    this.timeoutMs = options.timeoutMs ?? 45000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fallback = options.fallbackProvider ?? new FakeTtsProvider();
  }

  async synthesize(text: string, path: string): Promise<{ path: string; duration: number }> {
    if (!text.trim()) throw new Error('segmento vazio');
    if (!this.apiKey) {
      return this.fallback.synthesize(text, path);
    }

    await mkdir(dirname(path), { recursive: true });

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          models: [this.model, 'openai/gpt-audio'],
          modalities: ['text', 'audio'],
          audio: {
            voice: this.voice,
            format: 'mp3',
          },
          messages: [
            {
              role: 'system',
              content:
                'Você é um narrador profissional de audiolivros em português do Brasil. Leia exatamente o texto enviado pelo usuário com entonação cinematográfica natural, sem adicionar comentários.',
            },
            { role: 'user', content: text },
          ],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return this.fallback.synthesize(text, path);
      }

      const payload = (await response.json()) as {
        choices?: {
          message?: {
            audio?: { data?: string };
          };
        }[];
      };

      const audioBase64 = payload.choices?.[0]?.message?.audio?.data;
      if (!audioBase64) {
        return this.fallback.synthesize(text, path);
      }

      const buffer = Buffer.from(audioBase64, 'base64');
      if (buffer.byteLength < 64) {
        return this.fallback.synthesize(text, path);
      }

      const tmp = `${path}.tmp`;
      await writeFile(tmp, buffer);
      await rename(tmp, path).catch(async (err) => {
        await unlink(tmp).catch(() => {});
        throw err;
      });

      const probed = await probeDurationSeconds(path);
      const estimated = Math.max(1.0, text.trim().split(/\s+/).length * 0.4);
      return { path, duration: probed ?? estimated };
    } catch {
      return this.fallback.synthesize(text, path);
    }
  }

  async synthesizeSegments(
    segments: { id: string; text: string }[],
    dir: string,
  ): Promise<{ timed: TimedSpeech[]; duration: number }> {
    let cursor = 0;
    const timed: TimedSpeech[] = [];
    for (const s of segments) {
      const r = await this.synthesize(s.text, `${dir}/${s.id}.mp3`);
      timed.push({
        segmentId: s.id,
        text: s.text,
        startSeconds: cursor,
        endSeconds: cursor + r.duration,
      });
      cursor += r.duration;
    }
    return { timed, duration: cursor };
  }
}
