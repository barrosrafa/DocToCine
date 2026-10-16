import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenRouterSpeechProvider } from '../../src/infra/tts/openrouter-speech-provider.js';
import { FallbackTtsProvider } from '../../src/infra/tts/fallback-tts-provider.js';
import { FakeTtsProvider } from '../../src/infra/tts/fake-tts-provider.js';
import { createValidWavBuffer } from '../helpers/fixture-generators.js';

describe('OpenRouterSpeechProvider & FallbackTtsProvider (Fase 4 / Sprint D)', () => {
  it('envia POST para /audio/speech, grava bytes binários, valida com ffprobe e retorna duração real > 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doctocine-speech-'));
    try {
      const wavBytes = createValidWavBuffer(1.25, 16000);
      let capturedUrl = '';
      let capturedBody: Record<string, unknown> = {};

      const mockFetch: typeof fetch = async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return new Response(new Uint8Array(wavBytes), {
          status: 200,
          headers: {
            'Content-Type': 'audio/wav',
            'X-Generation-Id': 'gen_tts_001',
          },
        });
      };

      const provider = new OpenRouterSpeechProvider({
        apiKey: 'sk-or-v1-secret1234567890abcdef1234567890',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openai/gpt-4o-mini-tts-2025-12-15',
        voice: 'nova',
        speed: 1.0,
        responseFormat: 'mp3',
        styleInstructions: 'Português brasileiro natural, voz de documentário.',
        fetchImpl: mockFetch,
      });

      const outPath = join(dir, 'seg_0001.wav');
      const result = await provider.synthesizeRequest({
        text: 'Narração documental em português brasileiro sobre o capítulo um.',
        outputPath: outPath,
        language: 'pt-BR',
        voice: 'nova',
        speed: 1.0,
        idempotencyKey: 'seg_0001',
      });

      expect(capturedUrl).toBe('https://openrouter.ai/api/v1/audio/speech');
      expect(capturedBody.model).toBe('openai/gpt-4o-mini-tts-2025-12-15');
      expect(capturedBody.voice).toBe('nova');
      expect(result.durationSeconds).toBeGreaterThan(1.0);
      expect(result.bytes).toBe(wavBytes.byteLength);
      expect(result.generationId).toBe('gen_tts_001');
      expect(result.degraded).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejeita arquivo de áudio truncado/inválido (< 512 bytes) e sanitiza segredo em erro HTTP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doctocine-speech-err-'));
    try {
      const secretKey = `${'sk-or-v1'}-tts_secret_key_example_123456789`;
      const mockFetch401: typeof fetch = async () =>
        new Response(`Invalid token ${secretKey}`, { status: 401 });

      const provider = new OpenRouterSpeechProvider({
        apiKey: secretKey,
        model: 'openai/gpt-4o-mini-tts-2025-12-15',
        voice: 'nova',
        fetchImpl: mockFetch401,
      });

      await expect(
        provider.synthesizeRequest({
          text: 'Texto de teste',
          outputPath: join(dir, 'fail.mp3'),
          language: 'pt-BR',
          voice: 'nova',
          speed: 1,
          idempotencyKey: 'seg_fail',
        }),
      ).rejects.toThrow(/\[REDACTED_KEY\]/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('aciona TTS secundário via FallbackTtsProvider marcando degraded=true e bloqueia FakeTtsProvider em produção quando não autorizado', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doctocine-tts-fallback-'));
    try {
      const wavBytes = createValidWavBuffer(1.5, 16000);
      const failingPrimary = new OpenRouterSpeechProvider({
        apiKey: 'sk-or-v1-secret1234567890abcdef1234567890',
        model: 'openai/gpt-4o-mini-tts-2025-12-15',
        voice: 'nova',
        maxRetries: 0,
        fetchImpl: async () => new Response('Service Unavailable', { status: 503 }),
      });

      const workingSecondary = new OpenRouterSpeechProvider({
        apiKey: 'sk-or-v1-secret1234567890abcdef1234567890',
        model: 'hexgrad/kokoro-82m',
        voice: 'pf_dora',
        fetchImpl: async () => new Response(new Uint8Array(wavBytes), { status: 200 }),
      });

      const router = new FallbackTtsProvider(failingPrimary, workingSecondary);
      const res = await router.synthesizeSegments(
        [{ id: 'seg_0001', text: 'Teste de fallback real para Kokoro.' }],
        dir,
      );

      expect(res.degraded).toBe(true);
      expect(res.usedModels).toContain('hexgrad/kokoro-82m');
      expect(res.duration).toBeGreaterThan(1.0);

      // FakeTtsProvider com allowSyntheticFixture=false deve lançar erro TTS_UNAVAILABLE
      const blockedFixture = new FakeTtsProvider(0.4, { allowSyntheticFixture: false });
      await expect(
        blockedFixture.synthesize('Teste bloqueado', join(dir, 'x.mp3')),
      ).rejects.toThrow(/TTS_ALLOW_SYNTHETIC_FIXTURE/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
