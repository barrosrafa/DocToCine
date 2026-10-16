import 'dotenv/config';
import { z } from 'zod';

const optionalSecret = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1).optional(),
);

const optionalNonEmptyString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().trim().min(1).optional(),
);

const DEFAULT_FALLBACK_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'dots-studio/dots-3-note-preview:free',
  'liquid/lfm-2.5-2.6b:free',
  'openrouter/free',
];

const secureBaseUrl = z
  .string()
  .trim()
  .url()
  .default('https://openrouter.ai/api/v1')
  .refine(
    (u) => {
      const parsed = new URL(u);
      return (
        parsed.protocol === 'https:' ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1'
      );
    },
    { message: 'OPENROUTER_BASE_URL deve usar HTTPS (ou localhost para testes).' },
  );

const fallbackModelsSchema = z
  .preprocess(
    (v) => {
      if (Array.isArray(v)) return v;
      if (typeof v === 'string' && v.trim().length > 0) {
        return v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
      return DEFAULT_FALLBACK_MODELS;
    },
    z.array(z.string().min(1)).min(1),
  )
  .default(DEFAULT_FALLBACK_MODELS);

const booleanString = (defaultVal: 'true' | 'false') =>
  z
    .preprocess(
      (v) => {
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        return v;
      },
      z.enum(['true', 'false']).default(defaultVal),
    )
    .transform((v) => v === 'true');

const EnvSchema = z.object({
  OPENROUTER_API_KEY: optionalSecret,
  OPENROUTER_BASE_URL: secureBaseUrl,
  OPENROUTER_APP_URL: z.string().trim().url().default('https://github.com/doctocine/lcbooks'),
  OPENROUTER_APP_TITLE: z.string().trim().min(1).default('DocToCine Pipeline'),
  OPENROUTER_SUMMARY_MODEL: z.string().trim().min(1).default('google/gemini-3.5-flash-lite'),
  OPENROUTER_SCRIPT_MODEL: z.string().trim().min(1).default('anthropic/claude-haiku-5.5'),
  OPENROUTER_STORYBOARD_MODEL: z.string().trim().min(1).default('google/gemini-3.5-flash-lite'),
  OPENROUTER_IMAGE_MODEL: z.string().trim().min(1).default('google/gemini-3.1-flash-lite-image'),
  OPENROUTER_AUDIO_MODEL: z.string().trim().min(1).default('openai/gpt-audio-mini'),
  OPENROUTER_FALLBACK_MODELS: fallbackModelsSchema,
  OPENROUTER_TEXT_FALLBACK_MODELS: fallbackModelsSchema,
  OPENROUTER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(45000),
  LLM_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
  SCENE_PROVIDER: z.enum(['openrouter', 'sharp']).default('openrouter'),
  SCENE_FALLBACK_PROVIDER: z.enum(['sharp', 'none']).default('sharp'),
  SCENE_CONCURRENCY: z.coerce.number().int().min(1).max(6).default(2),
  SCENE_CACHE_ENABLED: booleanString('true'),
  VISUAL_SHOT_TARGET_SECONDS: z.coerce.number().min(3).max(20).default(8),
  AI_IMAGE_MIN_INTERVAL_SECONDS: z.coerce.number().min(5).max(120).default(18),
  MAX_GENERATED_IMAGES_PER_VIDEO: z.coerce.number().int().min(0).max(500).default(80),
  TTS_PROVIDER: z.enum(['openrouter', 'openrouter-speech', 'fake']).default('openrouter'),
  TTS_LANGUAGE: z.string().trim().min(2).default('pt-BR'),
  TTS_VOICE: z.string().trim().min(1).default('nova'),
  TTS_SPEAKING_RATE: z.coerce.number().min(0.25).max(4).default(1),
  OPENROUTER_TTS_MODEL: z.string().trim().min(1).default('openai/gpt-4o-mini-tts-2025-12-15'),
  OPENROUTER_TTS_VOICE: z.string().trim().min(1).default('nova'),
  OPENROUTER_TTS_FALLBACK_MODEL: z.string().trim().min(1).default('hexgrad/kokoro-82m'),
  OPENROUTER_TTS_FALLBACK_VOICE: optionalNonEmptyString,
  OPENROUTER_TTS_SPEED: z.coerce.number().min(0.7).max(1.2).default(1),
  OPENROUTER_TTS_FORMAT: z.enum(['mp3', 'pcm']).default('mp3'),
  TTS_MAX_CHARS_PER_REQUEST: z.coerce.number().int().min(200).max(4000).default(1800),
  TTS_MAX_PARALLEL_REQUESTS: z.coerce.number().int().min(1).max(6).default(2),
  TTS_ALLOW_SYNTHETIC_FIXTURE: booleanString('false'),
  ENABLE_WORD_ALIGNMENT: booleanString('true'),
  ALIGNMENT_PROVIDER: z.enum(['whisperx', 'approximate']).default('whisperx'),
  TARGET_WORDS_PER_MINUTE: z.coerce.number().int().min(90).max(190).default(135),
  SCRIPT_DURATION_TOLERANCE_PERCENT: z.coerce.number().min(3).max(20).default(8),
  MAX_JOB_COST_USD: z.coerce.number().min(0).default(5),
  COST_LIMIT_ACTION: z.enum(['warn', 'stop']).default('stop'),
  VIDEO_WIDTH: z.coerce.number().int().min(320).max(3840).default(1920),
  VIDEO_HEIGHT: z.coerce.number().int().min(320).max(3840).default(1080),
  VIDEO_FPS: z.coerce.number().int().min(15).max(60).default(30),
  VIDEO_CRF: z.coerce.number().int().min(16).max(30).default(20),
  VIDEO_PRESET: z.string().trim().min(1).default('medium'),
  BURN_CAPTIONS: booleanString('true'),
  CAPTION_FONT_NAME: z.string().trim().min(1).default('Arial'),
  LCBOOKS_FONT_PATH: optionalNonEmptyString,
  MAX_PDF_MB: z.coerce.number().int().min(1).max(1000).default(100),
  MAX_PDF_PAGES: z.coerce.number().int().min(1).max(10000).default(1000),
  MAX_CHAPTER_CHARS_PER_CHUNK: z.coerce.number().int().min(2000).max(50000).default(12000),
  CHAPTER_CHUNK_OVERLAP_CHARS: z.coerce.number().int().min(100).max(5000).default(600),
  MAX_RETRY_ATTEMPTS: z.coerce.number().int().min(0).max(8).default(3),
});

export type Settings = z.infer<typeof EnvSchema>;

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const r = EnvSchema.safeParse(env);
  if (!r.success)
    throw new Error(
      `Configuração inválida: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  return r.data;
}

export function requireOpenRouter(settings: Settings): Settings {
  if (!settings.OPENROUTER_API_KEY)
    throw new Error('Defina OPENROUTER_API_KEY para chamadas reais ao OpenRouter.');
  return settings;
}

export function publicSettings(s: Settings): Omit<Settings, 'OPENROUTER_API_KEY'> {
  const safe = { ...s };
  delete safe.OPENROUTER_API_KEY;
  return safe;
}
