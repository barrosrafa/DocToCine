import type { StoryboardScene } from '../../domain/schemas/video.schema.js';
import type { SceneAssetProvider } from '../../domain/ports/scene-provider.js';
import { SharpSceneProvider } from './sharp-scene-provider.js';

export type OpenRouterSceneOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  width?: number;
  height?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function decodeDataUrlToBuffer(url: string): Buffer | null {
  const match = url.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([\s\S]+)$/);
  if (!match?.[1]) return null;
  return Buffer.from(match[1].trim(), 'base64');
}

export class OpenRouterSceneProvider implements SceneAssetProvider {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly width: number;
  private readonly height: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
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
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.compositor = new SharpSceneProvider(this.width, this.height);
  }

  private async fetchAiBackground(scene: StoryboardScene): Promise<Buffer | undefined> {
    if (!this.apiKey) return undefined;

    const aspectRatio = this.height > this.width ? '9:16' : '16:9';
    const prompt = `Crie uma ilustração cinematográfica atmosférica e sem textos escritos (${aspectRatio}) para a seguinte cena: ${scene.visualPrompt || scene.onScreenText}. Iluminação dramática de cinema, alta definição.`;

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          models: [this.model, 'openai/gpt-5-image-mini'],
          modalities: ['image', 'text'],
          image_config: { aspect_ratio: aspectRatio },
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) return undefined;

      const payload = (await response.json()) as {
        choices?: {
          message?: {
            content?: string | null;
            images?: { image_url?: { url?: string } }[];
          };
        }[];
      };

      const msg = payload.choices?.[0]?.message;
      const imageUrl = msg?.images?.[0]?.image_url?.url;
      if (imageUrl) {
        const decoded = decodeDataUrlToBuffer(imageUrl);
        if (decoded) return decoded;
      }

      if (msg?.content) {
        const inlineMatch = msg.content.match(
          /(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)/,
        );
        if (inlineMatch?.[1]) {
          const decoded = decodeDataUrlToBuffer(inlineMatch[1]);
          if (decoded) return decoded;
        }
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  async create(scene: StoryboardScene, path: string, backgroundBuffer?: Buffer): Promise<string> {
    const bg = backgroundBuffer ?? (await this.fetchAiBackground(scene));
    return this.compositor.create(scene, path, bg);
  }
}
