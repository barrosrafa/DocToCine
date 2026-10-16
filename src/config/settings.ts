import 'dotenv/config';
import { z } from 'zod';

const optionalSecret = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1).optional(),
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
  OPENROUTER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(45000),
  LLM_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
  SCENE_PROVIDER: z.enum(['openrouter', 'sharp']).default('openrouter'),
  TTS_PROVIDER: z.enum(['openrouter', 'fake']).default('openrouter'),
  TTS_LANGUAGE: z.string().trim().min(2).default('pt-BR'),
  TTS_VOICE: z.string().trim().min(1).default('nova'),
  TTS_SPEAKING_RATE: z.coerce.number().min(0.25).max(4).default(1),
  VIDEO_WIDTH: z.coerce.number().int().min(320).max(3840).default(1920),
  VIDEO_HEIGHT: z.coerce.number().int().min(320).max(3840).default(1080),
  VIDEO_FPS: z.coerce.number().int().min(15).max(60).default(30),
  VIDEO_CRF: z.coerce.number().int().min(16).max(30).default(20),
  VIDEO_PRESET: z.string().trim().min(1).default('medium'),
  BURN_CAPTIONS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  LCBOOKS_FONT_PATH: z.string().trim().min(1).optional(),
  MAX_PDF_MB: z.coerce.number().int().min(1).max(1000).default(100),
  MAX_PDF_PAGES: z.coerce.number().int().min(1).max(10000).default(1000),
  MAX_CHAPTER_CHARS_PER_CHUNK: z.coerce.number().int().min(2000).max(50000).default(12000),
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
