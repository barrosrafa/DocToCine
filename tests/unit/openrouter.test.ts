import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import sharp from 'sharp';
import {
  OpenRouterLlmProvider,
  extractJsonPayload,
  buildModelBatches,
} from '../../src/infra/llm/openrouter-provider.js';
import { OpenRouterTtsProvider } from '../../src/infra/tts/openrouter-tts-provider.js';
import { OpenRouterSceneProvider } from '../../src/infra/media/openrouter-scene-provider.js';
import { StoryboardSceneSchema } from '../../src/domain/schemas/video.schema.js';

describe('OpenRouterLlmProvider & utilitários de protocolo', () => {
  it('extrai JSON limpo mesmo com blocos markdown e tags <think>', () => {
    const raw = `<think>Analisando estrutura do capítulo...</think>\nAqui está o resultado:\n\`\`\`json\n{"title": "Cap 1", "count": 3}\n\`\`\`\nEspero que ajude!`;
    expect(extractJsonPayload(raw)).toEqual({ title: 'Cap 1', count: 3 });
  });

  it('divide candidatos de modelos em lotes de no máximo 3 (limite da API OpenRouter)', () => {
    const batches = buildModelBatches('anthropic/claude-haiku-5.5', [
      'google/gemini-3.5-flash-lite',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'dots-studio/dots-3-note-preview:free',
      'openrouter/free',
    ]);
    expect(batches).toEqual([
      [
        'anthropic/claude-haiku-5.5',
        'google/gemini-3.5-flash-lite',
        'nvidia/nemotron-3-super-120b-a12b:free',
      ],
      ['dots-studio/dots-3-note-preview:free', 'openrouter/free'],
    ]);
  });

  it('tenta modelos em ordem serializada sem pular elementos e preserva usage/usedModel em generateStructuredWithMeta', async () => {
    const requestedModels: string[] = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string; models?: string[] };
      const model = body.model ?? body.models?.[0] ?? '';
      requestedModels.push(model);
      if (requestedModels.length === 1) {
        return new Response(
          JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } }),
          { status: 402 },
        );
      }
      if (requestedModels.length === 2) {
        return new Response(
          JSON.stringify({ error: { message: 'Provider overloaded', code: 503 } }),
          { status: 503 },
        );
      }
      return new Response(
        JSON.stringify({
          id: 'gen-123',
          model: 'dots-studio/dots-3-note-preview:free',
          usage: {
            prompt_tokens: 120,
            completion_tokens: 45,
            total_tokens: 165,
            cost: 0,
          },
          choices: [{ message: { content: '{"ok":true,"modelUsed":"dots-free"}' } }],
        }),
        { status: 200 },
      );
    };

    const sleeps: number[] = [];
    const provider = new OpenRouterLlmProvider({
      apiKey: 'sk-or-v1-secret1234567890abcdef1234567890',
      summaryModel: 'google/gemini-3.5-flash-lite',
      scriptModel: 'anthropic/claude-haiku-5.5',
      storyboardModel: 'google/gemini-3.5-flash-lite',
      fallbackModels: [
        'nvidia/nemotron-3-super-120b-a12b:free',
        'dots-studio/dots-3-note-preview:free',
        'liquid/lfm-2.5-2.6b:free',
      ],
      maxRetries: 0,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: fakeFetch,
    });

    const schema = z.object({ ok: z.boolean(), modelUsed: z.string() });
    const meta = await provider.generateStructuredWithMeta('Teste de roteiro', schema, {
      task: 'script',
    });

    expect(meta.data).toEqual({ ok: true, modelUsed: 'dots-free' });
    expect(meta.requestedModel).toBe('anthropic/claude-haiku-5.5');
    expect(meta.usedModel).toBe('dots-studio/dots-3-note-preview:free');
    expect(meta.degraded).toBe(true);
    expect(meta.usage?.promptTokens).toBe(120);
    expect(meta.usage?.completionTokens).toBe(45);
    expect(meta.usage?.totalTokens).toBe(165);
    expect(requestedModels).toEqual([
      'anthropic/claude-haiku-5.5',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'dots-studio/dots-3-note-preview:free',
    ]);
  });

  it('usa retry/backoff respeitando Retry-After em 429 sem timers reais e repara schema inválido em até 1 tentativa', async () => {
    const sleeps: number[] = [];
    let callCount = 0;
    const fakeFetch: typeof fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('Rate limited', {
          status: 429,
          headers: { 'Retry-After': '2' },
        });
      }
      if (callCount === 2) {
        // JSON sintaticamente válido, mas fora do schema (count é string em vez de number)
        return new Response(
          JSON.stringify({
            model: 'google/gemini-3.5-flash-lite',
            choices: [{ message: { content: '{"title":"Cap 1","count":"tres"}' } }],
          }),
          { status: 200 },
        );
      }
      // Tentativa de repair
      return new Response(
        JSON.stringify({
          model: 'google/gemini-3.5-flash-lite',
          choices: [{ message: { content: '{"title":"Cap 1","count":3}' } }],
        }),
        { status: 200 },
      );
    };

    const provider = new OpenRouterLlmProvider({
      apiKey: 'sk-or-v1-secret1234567890abcdef1234567890',
      summaryModel: 'google/gemini-3.5-flash-lite',
      fallbackModels: [],
      maxRetries: 1,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: fakeFetch,
    });

    const schema = z.object({ title: z.string(), count: z.number() });
    const res = await provider.generateStructured('Analise', schema, { task: 'summary' });
    expect(res).toEqual({ title: 'Cap 1', count: 3 });
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
    expect(callCount).toBe(3);
  });

  it('não tenta fallback em 401 e sanitiza a chave de API caso todas as tentativas falhem', async () => {
    const secretKey = `${'sk-or-v1'}-test_redaction_token_example_123456`;
    let attempts = 0;
    const failingFetch: typeof fetch = async () => {
      attempts++;
      return new Response(`Unauthorized key ${secretKey}`, { status: 401 });
    };

    const provider = new OpenRouterLlmProvider({
      apiKey: secretKey,
      fallbackModels: ['openrouter/free'],
      maxRetries: 2,
      fetchImpl: failingFetch,
    });

    await expect(
      provider.generateStructured('prompt', z.object({ a: z.string() })),
    ).rejects.toThrow(/\[REDACTED_KEY\]/);
    expect(attempts).toBe(1);
  });
});

describe('OpenRouterTtsProvider & OpenRouterSceneProvider (Áudio e Vídeo/Cenas)', () => {
  it('faz fallback automático para síntese local no OpenRouterTtsProvider quando retorna 402', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doctocine-tts-'));
    try {
      const failingAudioFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({ error: { message: 'Requires $0.50 balance for audio', code: 402 } }),
          { status: 402 },
        );

      const tts = new OpenRouterTtsProvider({
        apiKey: 'sk-or-v1-test1234567890abcdef',
        model: 'openai/gpt-audio-mini',
        voice: 'nova',
        fetchImpl: failingAudioFetch,
      });

      const out = await tts.synthesizeSegments(
        [{ id: 'seg_0001', text: 'Narração de teste em português para o capítulo um.' }],
        dir,
      );

      expect(out.timed).toHaveLength(1);
      expect(out.duration).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('compõe imagem gerada pelo OpenRouterSceneProvider com tipografia Sharp', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doctocine-scene-'));
    try {
      const sampleBg = await sharp({
        create: {
          width: 320,
          height: 180,
          channels: 3,
          background: { r: 20, g: 40, b: 90 },
        },
      })
        .png()
        .toBuffer();

      const dataUrl = `data:image/png;base64,${sampleBg.toString('base64')}`;
      const imageFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'Cena gerada',
                  images: [{ type: 'image_url', image_url: { url: dataUrl } }],
                },
              },
            ],
          }),
          { status: 200 },
        );

      const sceneProvider = new OpenRouterSceneProvider({
        apiKey: 'sk-or-v1-test1234567890abcdef',
        model: 'google/gemini-3.1-flash-lite-image',
        width: 640,
        height: 360,
        fetchImpl: imageFetch,
      });

      const scene = StoryboardSceneSchema.parse({
        sceneId: 'scene_001',
        segmentIds: ['seg_0001'],
        visualPrompt: 'Mansão sombria no topo de um penhasco sob tempestade',
        onScreenText: 'A Proposta dos Penhascos',
        durationSeconds: 5,
      });

      const outPath = join(dir, 'scene_001.png');
      await sceneProvider.create(scene, outPath);

      const st = await stat(outPath);
      expect(st.size).toBeGreaterThan(500);
      const meta = await sharp(outPath).metadata();
      expect(meta.width).toBe(640);
      expect(meta.height).toBe(360);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

import { ScriptGenerator } from '../../src/application/services/script-generator.js';
import {
  ChapterBoundarySchema,
  normalizeChapterSummary,
} from '../../src/domain/schemas/chapter.schema.js';
import type { LlmCallOptions, LlmProvider } from '../../src/domain/ports/llm-provider.js';

describe('integração de roteamento por tarefa na camada de aplicação', () => {
  it('ScriptGenerator invoca LlmProvider especificando a tarefa script', async () => {
    let capturedTask: string | undefined;
    const mockLlm: LlmProvider = {
      async generateStructured<T>(
        _prompt: string,
        schema: { parse(value: unknown): T },
        options?: LlmCallOptions,
      ): Promise<T> {
        capturedTask = options?.task;
        return schema.parse({
          title: 'Cap 1',
          durationMinutes: 1,
          hook: 'Gancho',
          beats: ['Beat 1', 'Beat 2', 'Beat 3'],
          narration: 'Parágrafo 1.\n\nParágrafo 2.\n\nParágrafo 3.',
          cta: 'Inscreva-se',
          bRollAndVisuals: ['Cena 1', 'Cena 2', 'Cena 3'],
        });
      },
    };

    const gen = new ScriptGenerator(mockLlm);
    const summary = normalizeChapterSummary({ title: 'Cap 1', thesis: 'Tese central' });
    const boundary = ChapterBoundarySchema.parse({
      number: 1,
      title: 'Cap 1',
      startPage: 1,
      endPage: 5,
    });

    await gen.generate(summary, boundary, 1);
    expect(capturedTask).toBe('script');
  });
});
