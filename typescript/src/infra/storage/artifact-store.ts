import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { VideoManifestSchema, type VideoManifest } from '../../domain/schemas/video.schema.js';
export function stableHash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(value, Object.keys(value as object).sort()))
    .digest('hex');
}
export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, path);
  return path;
}
export class ArtifactStore {
  constructor(
    readonly baseDir: string,
    readonly jobId = 'job_default',
  ) {}
  relative(path: string) {
    return relative(this.baseDir, path).split(sep).join('/');
  }
  chapterDir(n: number) {
    return resolve(this.baseDir, `chapter_${String(n).padStart(2, '0')}`);
  }
  videoDir(n: number, d: number) {
    return resolve(this.chapterDir(n), `video_${String(d).padStart(2, '0')}min`);
  }
  async saveJson(name: string, value: unknown) {
    const p = resolve(this.baseDir, name);
    if (!p.startsWith(resolve(this.baseDir) + sep))
      throw new Error('Caminho de artefato inválido.');
    return atomicJson(p, value);
  }
  async loadManifest(n: number, d: number) {
    try {
      return VideoManifestSchema.parse(
        JSON.parse(await readFile(resolve(this.videoDir(n, d), 'manifest.json'), 'utf8')),
      );
    } catch {
      return undefined;
    }
  }
  async saveManifest(n: number, d: number, m: VideoManifest) {
    return atomicJson(resolve(this.videoDir(n, d), 'manifest.json'), VideoManifestSchema.parse(m));
  }
  async saveScript(n: number, d: number, script: unknown) {
    return atomicJson(resolve(this.videoDir(n, d), `script_${d}min.json`), script);
  }
}
