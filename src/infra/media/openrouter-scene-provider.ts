import sharp from 'sharp';
import type { StoryboardScene } from '../../domain/schemas/video.schema.js';
import type { AssetProvenance } from '../../domain/schemas/scene.schema.js';
import type { SceneAssetProvider } from '../../domain/ports/scene-provider.js';
import { SharpSceneProvider } from './sharp-scene-provider.js';
import { SceneCache, stableAssetHash } from '../storage/scene-cache.js';

export type OpenRouterSceneOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  width?: number;
  height?: number;
  timeoutMs?: number;
  sceneCache?: SceneCache;
  forceRegenerate?: boolean;
  fetchImpl?: typeof fetch;
  onUsage?: (event: {
    model: string;
    elapsedMs: number;
    cached: boolean;
    fallback: boolean;
  }) => void;
};

const MAX_REMOTE_IMAGE_BYTES = 15 * 1024 * 1024;
const STYLE_BIBLE_VERSION = 'v2.0';

function decodeDataUrlToBuffer(url: string): Buffer | null {
  const match = url.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([\s\S]+)$/);
  if (!match?.[1]) return null;
  return Buffer.from(match[1].trim(), 'base64');
}

export function isSafeRemoteImageUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '[::1]' ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      return false;
    }
    // Block RFC1918 / link-local IPv4 ranges
    if (
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function validateImageBuffer(buf: Buffer): Promise<boolean> {
  if (buf.byteLength < 64 || buf.byteLength > MAX_REMOTE_IMAGE_BYTES) return false;
  try {
    const meta = await sharp(buf).metadata();
    return Boolean(meta.width && meta.height && meta.width >= 16 && meta.height >= 16);
  } catch {
    return false;
  }
}

export class OpenRouterSceneProvider implements SceneAssetProvider {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly width: number;
  private readonly height: number;
  private readonly timeoutMs: number;
  private readonly sceneCache?: SceneCache;
  private readonly forceRegenerate: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly onUsage?: OpenRouterSceneOptions['onUsage'];
  private readonly compositor: SharpSceneProvider;

  constructor(options: OpenRouterSceneOptions = {}) {
    if (options.apiKey !== undefined) {
      this.apiKey = options.apiKey;
    }
    this.baseUrl = (options.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.model = options.model ?? 'google/gemini-3.1-flash-lite-image';
    this.width = options.width ?? 1920;
    this.height = options.height ?? 1080;
    this.timeoutMs = options.timeoutMs ?? 45000;
    if (options.sceneCache !== undefined) {
      this.sceneCache = options.sceneCache;
    }
    this.forceRegenerate = options.forceRegenerate ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (options.onUsage !== undefined) {
      this.onUsage = options.onUsage;
    }
    this.compositor = new SharpSceneProvider(this.width, this.height);
  }

  private async downloadSafeRemoteImage(url: string): Promise<Buffer | undefined> {
    if (!isSafeRemoteImageUrl(url)) return undefined;
    try {
      const resp = await this.fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(Math.min(20000, this.timeoutMs)),
      });
      if (!resp.ok) return undefined;
      const contentType = (resp.headers.get('content-type') ?? '').toLowerCase();
      if (contentType && !contentType.startsWith('image/')) {
        return undefined;
      }
      const contentLength = Number(resp.headers.get('content-length') ?? 0);
      if (contentLength > MAX_REMOTE_IMAGE_BYTES) return undefined;

      const buf = Buffer.from(await resp.arrayBuffer());
      if (await validateImageBuffer(buf)) return buf;
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchAiBackground(
    scene: StoryboardScene,
  ): Promise<{ buffer: Buffer; provenance: 'ai' | 'cache' } | undefined> {
    const normalizedPrompt = (scene.visualPrompt || scene.onScreenText || 'DocToCine')
      .trim()
      .replace(/\s+/g, ' ');
    const cacheKey = stableAssetHash({
      model: this.model,
      prompt: normalizedPrompt,
      width: this.width,
      height: this.height,
      styleBibleVersion: STYLE_BIBLE_VERSION,
    });

    if (this.sceneCache && !this.forceRegenerate) {
      const hit = await this.sceneCache.get(cacheKey);
      if (hit) {
        this.onUsage?.({ model: this.model, elapsedMs: 0, cached: true, fallback: false });
        return { buffer: hit.buffer, provenance: 'cache' };
      }
    }

    if (!this.apiKey) return undefined;

    const aspectRatio = this.height > this.width ? '9:16' : '16:9';
    const prompt = `Crie uma ilustração cinematográfica atmosférica e sem textos escritos, letras, logotipos ou marcas d'água (${aspectRatio}) para a seguinte cena: ${normalizedPrompt}. Iluminação dramática de cinema, alta definição.`;
    const startedAt = Date.now();

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          models: [this.model],
          modalities: ['image', 'text'],
          image_config: { aspect_ratio: aspectRatio },
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) return undefined;

      const payload = (await response.json()) as {
        id?: string;
        choices?: {
          message?: {
            content?: string | null;
            images?: { image_url?: { url?: string } }[];
          };
        }[];
      };

      const msg = payload.choices?.[0]?.message;
      const imageUrl = msg?.images?.[0]?.image_url?.url;
      let candidateBuffer: Buffer | undefined;

      if (imageUrl) {
        const decoded = decodeDataUrlToBuffer(imageUrl);
        if (decoded && (await validateImageBuffer(decoded))) {
          candidateBuffer = decoded;
        } else if (isSafeRemoteImageUrl(imageUrl)) {
          candidateBuffer = await this.downloadSafeRemoteImage(imageUrl);
        }
      }

      if (!candidateBuffer && msg?.content) {
        const inlineMatch = msg.content.match(
          /(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)/,
        );
        if (inlineMatch?.[1]) {
          const decoded = decodeDataUrlToBuffer(inlineMatch[1]);
          if (decoded && (await validateImageBuffer(decoded))) {
            candidateBuffer = decoded;
          }
        }
      }

      if (!candidateBuffer) return undefined;

      if (this.sceneCache) {
        await this.sceneCache.put(cacheKey, candidateBuffer, {
          model: this.model,
          width: this.width,
          height: this.height,
          ...(payload.id !== undefined ? { requestId: payload.id } : {}),
        });
      }

      this.onUsage?.({
        model: this.model,
        elapsedMs: Date.now() - startedAt,
        cached: false,
        fallback: false,
      });

      return { buffer: candidateBuffer, provenance: 'ai' };
    } catch {
      return undefined;
    }
  }

  async createWithProvenance(
    scene: StoryboardScene,
    path: string,
    backgroundBuffer?: Buffer,
  ): Promise<{ path: string; provenance: AssetProvenance; backgroundBuffer?: Buffer }> {
    if (backgroundBuffer) {
      const out = await this.compositor.create(scene, path, backgroundBuffer);
      return { path: out, provenance: 'cache', backgroundBuffer };
    }

    const fetched = await this.fetchAiBackground(scene);
    const out = await this.compositor.create(scene, path, fetched?.buffer);
    return {
      path: out,
      provenance: fetched ? fetched.provenance : 'sharp-fallback',
      ...(fetched?.buffer !== undefined ? { backgroundBuffer: fetched.buffer } : {}),
    };
  }

  async create(scene: StoryboardScene, path: string, backgroundBuffer?: Buffer): Promise<string> {
    const res = await this.createWithProvenance(scene, path, backgroundBuffer);
    return res.path;
  }
}
