import { describe, expect, it } from 'vitest';
import { VideoScriptSchema, ensureScriptSegments } from '../../src/domain/schemas/script.schema.js';
import { normalizeChapterSummary } from '../../src/domain/schemas/chapter.schema.js';
import { sanitizeMessage } from '../../src/core/logging/redact.js';
import { canTransition } from '../../src/domain/schemas/video.schema.js';
describe('contratos de domínio', () => {
  it('valida durações e cria segmentos legados', () => {
    expect(() =>
      VideoScriptSchema.parse({ durationMinutes: 5, beats: ['x'], narration: 'x' }),
    ).toThrow();
    const s = VideoScriptSchema.parse({
      durationMinutes: 1,
      beats: ['A', 'B'],
      narration: 'Primeiro.\n\nSegundo.',
    });
    expect(ensureScriptSegments(s, [2]).segments.map((x) => x.id)).toEqual([
      'seg_0001',
      'seg_0002',
    ]);
  });
  it('normaliza claims legados e retém páginas', () => {
    const s = normalizeChapterSummary({
      keyPoints: [{ claim: 'Ideia', sourcePages: [4], confidence: 'high' }],
    });
    expect(s.keyPoints).toEqual(['Ideia']);
    expect(s.sourcePages).toEqual([4]);
  });
  it('redige segredos (incluindo chaves OpenRouter sk-or-v1) e controla transições', () => {
    expect(sanitizeMessage('AIzaSySecretKey1234567890 token secreto', ['secreto'])).not.toContain(
      'secreto',
    );
    const orMsg = sanitizeMessage(
      `Bearer ${'sk-or-v1'}-test_redaction_token_example_123456 falhou`,
    );
    expect(orMsg).not.toContain('sk-or-v1-');
    expect(orMsg).toContain('[REDACTED_KEY]');
    expect(canTransition('pending', 'script_ready')).toBe(true);
    expect(canTransition('completed', 'rendering')).toBe(false);
  });
});

import { loadSettings, publicSettings, requireOpenRouter } from '../../src/config/settings.js';

describe('configurações OpenRouter por atividade e segurança', () => {
  it('define modelos especializados padrão para resumo, roteiro, imagem/cena e áudio', () => {
    const s = loadSettings({});
    expect(s.OPENROUTER_BASE_URL).toBe('https://openrouter.ai/api/v1');
    expect(s.OPENROUTER_SUMMARY_MODEL).toBe('google/gemini-3.5-flash-lite');
    expect(s.OPENROUTER_SCRIPT_MODEL).toBe('anthropic/claude-haiku-5.5');
    expect(s.OPENROUTER_IMAGE_MODEL).toBe('google/gemini-3.1-flash-lite-image');
    expect(s.OPENROUTER_AUDIO_MODEL).toBe('openai/gpt-audio-mini');
    expect(s.OPENROUTER_FALLBACK_MODELS.length).toBeGreaterThanOrEqual(3);
    expect(s.TTS_PROVIDER).toBe('openrouter');
    expect(s.OPENROUTER_TTS_MODEL).toBe('openai/gpt-4o-mini-tts-2025-12-15');
    expect(s.OPENROUTER_TTS_VOICE).toBe('nova');
    expect(s.OPENROUTER_TTS_FALLBACK_MODEL).toBe('hexgrad/kokoro-82m');
    expect(s.OPENROUTER_TTS_SPEED).toBe(1);
    expect(s.OPENROUTER_TTS_FORMAT).toBe('mp3');
    expect(s.TTS_MAX_CHARS_PER_REQUEST).toBe(1800);
    expect(s.TTS_MAX_PARALLEL_REQUESTS).toBe(2);
    expect(s.TTS_ALLOW_SYNTHETIC_FIXTURE).toBe(false);
    expect(s.VISUAL_SHOT_TARGET_SECONDS).toBe(8);
    expect(s.AI_IMAGE_MIN_INTERVAL_SECONDS).toBe(18);
    expect(s.MAX_GENERATED_IMAGES_PER_VIDEO).toBe(80);
    expect(s.SCENE_CACHE_ENABLED).toBe(true);
    expect(s.ENABLE_WORD_ALIGNMENT).toBe(true);
    expect(s.ALIGNMENT_PROVIDER).toBe('whisperx');
    expect(s.TARGET_WORDS_PER_MINUTE).toBe(135);
    expect(s.SCRIPT_DURATION_TOLERANCE_PERCENT).toBe(8);
    expect(s.MAX_JOB_COST_USD).toBe(5);
    expect(s.COST_LIMIT_ACTION).toBe('stop');
  });

  it('rejeita URLs inseguras (HTTP externo) e remove OPENROUTER_API_KEY em publicSettings', () => {
    expect(() => loadSettings({ OPENROUTER_BASE_URL: 'http://evil.example.com/api/v1' })).toThrow();
    const s = loadSettings({ OPENROUTER_API_KEY: 'sk-or-v1-testkey1234567890' });
    expect(requireOpenRouter(s).OPENROUTER_API_KEY).toBe('sk-or-v1-testkey1234567890');
    const pub = publicSettings(s);
    expect('OPENROUTER_API_KEY' in pub).toBe(false);
  });
});
