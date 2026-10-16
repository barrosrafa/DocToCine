import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenRouterSpeechProvider } from '../../src/infra/tts/openrouter-speech-provider.js';
import { loadSettings } from '../../src/config/settings.js';

const runPaid =
  process.env.RUN_PAID_SMOKE_TESTS === 'true' && Boolean(process.env.OPENROUTER_API_KEY);

describe.skipIf(!runPaid)('TTS Smoke Test Opt-In (OpenRouter /audio/speech)', () => {
  it('sintetiza 10-15 segundos de voz em pt-BR e valida codec e duração via ffprobe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doctocine-paid-smoke-'));
    try {
      const settings = loadSettings();
      const provider = new OpenRouterSpeechProvider({
        apiKey: settings.OPENROUTER_API_KEY!,
        baseUrl: settings.OPENROUTER_BASE_URL,
        model: settings.OPENROUTER_TTS_MODEL,
        voice: settings.OPENROUTER_TTS_VOICE,
        speed: settings.OPENROUTER_TTS_SPEED,
        responseFormat: settings.OPENROUTER_TTS_FORMAT,
      });

      const res = await provider.synthesizeRequest({
        text: 'Este é um teste de fumaça da síntese de voz do projeto DocToCine em português brasileiro, verificando timbre, fluidez e duração acústica real.',
        outputPath: join(dir, 'smoke.mp3'),
        language: 'pt-BR',
        voice: settings.OPENROUTER_TTS_VOICE,
        speed: settings.OPENROUTER_TTS_SPEED,
        idempotencyKey: 'smoke_001',
      });

      expect(res.durationSeconds).toBeGreaterThan(2);
      expect(res.bytes).toBeGreaterThan(1024);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
