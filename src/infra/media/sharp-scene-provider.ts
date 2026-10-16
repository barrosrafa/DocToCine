import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StoryboardScene } from '../../domain/schemas/video.schema.js';
function esc(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c,
  );
}
export class SharpSceneProvider {
  constructor(
    readonly width = 1920,
    readonly height = 1080,
  ) {}
  async create(scene: StoryboardScene, path: string) {
    await mkdir(dirname(path), { recursive: true });
    const title = esc(scene.onScreenText || scene.visualPrompt || 'LCBooks');
    const svg = `<svg width="${this.width}" height="${this.height}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop stop-color="#111827"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="8%" y="78%" fill="white" font-family="sans-serif" font-size="${Math.max(24, this.width / 28)}">${title}</text></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path);
    return path;
  }
}
