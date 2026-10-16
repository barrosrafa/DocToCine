import 'dotenv/config';
import { z } from 'zod';
const optionalSecret = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1).optional(),
);
const EnvSchema = z.object({
  GEMINI_API_KEY: optionalSecret,
  GOOGLE_API_KEY: optionalSecret,
  GEMINI_MODEL: z.string().trim().min(1).default('gemini-2.5-flash'),
  TTS_PROVIDER: z.enum(['google_cloud', 'fake']).default('fake'),
  TTS_LANGUAGE: z.string().trim().min(2).default('pt-BR'),
  TTS_VOICE: z.string().trim().min(1).default('pt-BR-Standard-A'),
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
export function requireGemini(settings: Settings): Settings {
  if (!settings.GEMINI_API_KEY && !settings.GOOGLE_API_KEY)
    throw new Error('Defina GEMINI_API_KEY ou GOOGLE_API_KEY para chamadas reais ao Gemini.');
  return settings;
}
export function publicSettings(s: Settings): Omit<Settings, 'GEMINI_API_KEY' | 'GOOGLE_API_KEY'> {
  const safe = { ...s };
  delete safe.GEMINI_API_KEY;
  delete safe.GOOGLE_API_KEY;
  return safe;
}
