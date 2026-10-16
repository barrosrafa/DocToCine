import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StoryboardScene } from '../../domain/schemas/video.schema.js';
import type { SceneAssetProvider } from '../../domain/ports/scene-provider.js';

function esc(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c,
  );
}

function wrapLines(text: string, maxCharsPerLine = 38): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) {
      cur = w;
    } else if (cur.length + w.length + 1 <= maxCharsPerLine) {
      cur += ' ' + w;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}

const PALETTES = [
  { bgStart: '#0f172a', bgEnd: '#1e1b4b', accent: '#a5b4fc', line: '#6366f1', glow: '#4f46e5' },
  { bgStart: '#022c22', bgEnd: '#064e3b', accent: '#6ee7b7', line: '#10b981', glow: '#059669' },
  { bgStart: '#1c0505', bgEnd: '#450a0a', accent: '#fca5a5', line: '#ef4444', glow: '#dc2626' },
  { bgStart: '#020617', bgEnd: '#0f172a', accent: '#7dd3fc', line: '#0ea5e9', glow: '#0284c7' },
  { bgStart: '#180728', bgEnd: '#3b0764', accent: '#d8b4fe', line: '#a855f7', glow: '#9333ea' },
  { bgStart: '#180c05', bgEnd: '#451a03', accent: '#fde68a', line: '#f59e0b', glow: '#d97706' },
];

export class SharpSceneProvider implements SceneAssetProvider {
  constructor(
    readonly width = 1280,
    readonly height = 720,
  ) {}

  async create(scene: StoryboardScene, path: string, backgroundBuffer?: Buffer): Promise<string> {
    await mkdir(dirname(path), { recursive: true });

    const sceneNum = parseInt(scene.sceneId.replace(/\D/g, '') || '1', 10);
    const pal = PALETTES[(sceneNum - 1) % PALETTES.length] ?? PALETTES[0]!;

    const mainText = scene.onScreenText || scene.visualPrompt || 'DocToCine';
    const lines = wrapLines(mainText, Math.floor(this.width / 32)).slice(0, 4);

    const titleFontSize = Math.max(28, Math.round(this.width / 26));
    const subFontSize = Math.max(16, Math.round(this.width / 50));
    const badgeFontSize = Math.max(14, Math.round(this.width / 60));

    const tspans = lines
      .map((l, i) => `<tspan x="8%" dy="${i === 0 ? 0 : titleFontSize * 1.3}">${esc(l)}</tspan>`)
      .join('');

    const subText =
      scene.visualPrompt && scene.visualPrompt !== scene.onScreenText
        ? esc(scene.visualPrompt.slice(0, 80))
        : '';

    const startY = this.height * 0.42;
    const hasCustomBg = Boolean(backgroundBuffer);

    const svg = `
<svg width="${this.width}" height="${this.height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg" cx="50%" cy="40%" r="75%">
      <stop offset="0%" stop-color="${pal.bgEnd}" stop-opacity="${hasCustomBg ? '0.55' : '0.9'}"/>
      <stop offset="100%" stop-color="${pal.bgStart}" stop-opacity="${hasCustomBg ? '0.82' : '1'}"/>
    </radialGradient>
    <linearGradient id="accentGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${pal.line}"/>
      <stop offset="100%" stop-color="${pal.glow}"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  
  <!-- Header badge -->
  <rect x="8%" y="10%" width="4" height="${badgeFontSize * 1.5}" fill="url(#accentGrad)" rx="2"/>
  <text x="calc(8% + 14px)" y="calc(10% + ${badgeFontSize * 1.1}px)" fill="${pal.accent}" font-family="system-ui, -apple-system, sans-serif" font-size="${badgeFontSize}" font-weight="700" letter-spacing="3">${esc(scene.sceneId.toUpperCase())}</text>

  <!-- Main narrative headline -->
  <text x="8%" y="${startY}" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-size="${titleFontSize}" font-weight="700" style="filter: drop-shadow(0 4px 12px rgba(0,0,0,0.6));">
    ${tspans}
  </text>

  <!-- Visual motif / subtitle footer -->
  ${
    subText
      ? `<text x="8%" y="82%" fill="#94a3b8" font-family="system-ui, -apple-system, sans-serif" font-size="${subFontSize}" font-weight="400">${subText}</text>`
      : ''
  }

  <!-- Cinematic progress bar -->
  <rect x="8%" y="90%" width="84%" height="3" fill="#334155" rx="1.5"/>
  <rect x="8%" y="90%" width="${Math.min(84, 15 + sceneNum * 12)}%" height="3" fill="url(#accentGrad)" rx="1.5"/>
</svg>`;

    const overlayBuf = Buffer.from(svg);

    if (backgroundBuffer) {
      try {
        await sharp(backgroundBuffer)
          .resize(this.width, this.height, { fit: 'cover' })
          .composite([{ input: overlayBuf, top: 0, left: 0 }])
          .png()
          .toFile(path);
        return path;
      } catch {
        // Fallback to pure SVG render if background buffer is invalid
      }
    }

    await sharp(overlayBuf).png().toFile(path);
    return path;
  }
}
