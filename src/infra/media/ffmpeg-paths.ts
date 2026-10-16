import { sep } from 'node:path';

export function normalizePosixPath(path: string): string {
  return path.split(sep).join('/').replace(/\\/g, '/');
}

export function escapeFfmpegFilterPath(path: string): string {
  const normalized = normalizePosixPath(path);
  return normalized
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

export function escapeConcatFilePath(path: string): string {
  return normalizePosixPath(path).replaceAll("'", "'\\''");
}

export function buildSubtitleFilterExpression(captionsPath: string): string {
  const escaped = escapeFfmpegFilterPath(captionsPath);
  if (captionsPath.toLowerCase().endsWith('.ass')) {
    return `ass='${escaped}'`;
  }
  return `subtitles='${escaped}'`;
}
