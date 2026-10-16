import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SubtitleCue } from '../../application/services/subtitle-cue-builder.js';

export type AssStyleOptions = {
  width: number;
  height: number;
  fontName?: string;
  fontSize?: number;
  marginV?: number;
  marginH?: number;
};

export function formatAssTime(s: number): string {
  const csTotal = Math.max(0, Math.round(s * 100));
  const h = Math.floor(csTotal / 360000);
  const m = Math.floor((csTotal % 360000) / 6000);
  const sec = Math.floor((csTotal % 6000) / 100);
  const cs = csTotal % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

export function formatAss(cues: SubtitleCue[], options: AssStyleOptions): string {
  const { width, height } = options;
  const isVertical = height > width;
  const fontName = (options.fontName ?? 'Arial').replace(/[,\\{}]/g, '');
  const fontSize =
    options.fontSize ?? (isVertical ? Math.round(width * 0.046) : Math.round(height * 0.044));
  // Safe area: keep 9:16 captions above bottom UI overlays (~14% from bottom)
  const marginV =
    options.marginV ?? (isVertical ? Math.round(height * 0.14) : Math.round(height * 0.07));
  const marginH = options.marginH ?? Math.round(width * 0.08);

  const header = `[Script Info]
Title: DocToCine Subtitles
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},&H00FFFFFF,&H0000FFFF,&H00141414,&H80000000,-1,0,0,0,100,100,0,0,1,3,1.5,2,${marginH},${marginH},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const events = cues.map(
    (cue) =>
      `Dialogue: 0,${formatAssTime(cue.startSeconds)},${formatAssTime(cue.endSeconds)},Default,,0,0,0,,${escapeAssText(cue.text)}`,
  );

  return `${header}\n${events.join('\n')}\n`;
}

export async function writeAss(
  cues: SubtitleCue[],
  path: string,
  options: AssStyleOptions,
): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, formatAss(cues, options), 'utf8');
  await rename(tmp, path);
  return path;
}
