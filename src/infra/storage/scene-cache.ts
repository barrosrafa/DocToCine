import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      const v = obj[k];
      if (v !== undefined) {
        out[k] = canonicalizeValue(v);
      }
    }
    return out;
  }
  return value;
}

export function stableAssetHash(value: unknown): string {
  const canonicalJson = JSON.stringify(canonicalizeValue(value));
  return createHash('sha256').update(canonicalJson).digest('hex');
}

export type CachedSceneMetadata = {
  hash: string;
  model: string;
  width: number;
  height: number;
  createdAt: string;
  bytes: number;
  requestId?: string;
};

export type CachedSceneHit = {
  path: string;
  buffer: Buffer;
  metadata: CachedSceneMetadata;
};

export class SceneCache {
  private readonly cacheDir: string;

  constructor(baseDir: string) {
    this.cacheDir = resolve(baseDir, 'cache', 'scenes');
  }

  private assertSafeHash(hash: string): string {
    const clean = hash.trim().toLowerCase();
    if (!/^[a-f0-9]{16,128}$/.test(clean)) {
      throw new Error(`Hash de cache inválido: ${hash}`);
    }
    return clean;
  }

  async get(hash: string): Promise<CachedSceneHit | undefined> {
    const safeHash = this.assertSafeHash(hash);
    const pngPath = join(this.cacheDir, `${safeHash}.png`);
    const metaPath = join(this.cacheDir, `${safeHash}.json`);

    try {
      const [buffer, metaRaw] = await Promise.all([readFile(pngPath), readFile(metaPath, 'utf8')]);
      if (buffer.byteLength < 128) return undefined;
      const metadata = JSON.parse(metaRaw) as CachedSceneMetadata;
      return { path: pngPath, buffer, metadata };
    } catch {
      return undefined;
    }
  }

  async put(
    hash: string,
    pngBuffer: Buffer,
    info: { model: string; width: number; height: number; requestId?: string },
  ): Promise<string> {
    const safeHash = this.assertSafeHash(hash);
    await mkdir(this.cacheDir, { recursive: true });
    const pngPath = join(this.cacheDir, `${safeHash}.png`);
    const metaPath = join(this.cacheDir, `${safeHash}.json`);

    const tmpPng = `${pngPath}.tmp`;
    const tmpMeta = `${metaPath}.tmp`;

    const metadata: CachedSceneMetadata = {
      hash: safeHash,
      model: info.model,
      width: info.width,
      height: info.height,
      createdAt: new Date().toISOString(),
      bytes: pngBuffer.byteLength,
      ...(info.requestId !== undefined ? { requestId: info.requestId } : {}),
    };

    await writeFile(tmpPng, pngBuffer);
    await rename(tmpPng, pngPath);
    await writeFile(tmpMeta, JSON.stringify(metadata, null, 2), 'utf8');
    await rename(tmpMeta, metaPath);

    return pngPath;
  }
}
