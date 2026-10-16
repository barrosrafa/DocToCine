import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { VideoManifestSchema, type VideoManifest } from '../../domain/schemas/video.schema.js';
import { canonicalizeValue } from './scene-cache.js';

export function stableHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeValue(value)))
    .digest('hex');
}

export async function atomicJson(path: string, value: unknown): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, path);
  return path;
}

export class ArtifactStore {
  private lockAcquired = false;

  constructor(
    readonly baseDir: string,
    readonly jobId = 'job_default',
  ) {}

  private resolveSafePath(name: string): string {
    if (isAbsolute(name)) {
      throw new Error('Caminho de artefato inválido: caminhos absolutos não são permitidos.');
    }
    const baseResolved = resolve(this.baseDir);
    const targetResolved = resolve(baseResolved, name);
    const rel = relative(baseResolved, targetResolved);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('Caminho de artefato inválido.');
    }
    return targetResolved;
  }

  relative(path: string): string {
    return relative(this.baseDir, path).split(sep).join('/');
  }

  chapterDir(n: number): string {
    return resolve(this.baseDir, `chapter_${String(n).padStart(2, '0')}`);
  }

  videoDir(n: number, d: number): string {
    return resolve(this.chapterDir(n), `video_${String(d).padStart(2, '0')}min`);
  }

  async saveJson(name: string, value: unknown): Promise<string> {
    const p = this.resolveSafePath(name);
    return atomicJson(p, value);
  }

  async readJson<T = unknown>(name: string): Promise<T | undefined> {
    try {
      const p = this.resolveSafePath(name);
      const raw = await readFile(p, 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async saveStageManifest(
    stage: string,
    status: 'pending' | 'running' | 'completed' | 'degraded' | 'failed' | 'skipped',
    metadata: Record<string, unknown> = {},
  ): Promise<string> {
    const safeStage = stage.replace(/[^a-zA-Z0-9_-]/g, '_');
    return this.saveJson(`stages/${safeStage}.json`, {
      schemaVersion: 2,
      jobId: this.jobId,
      stage,
      status,
      updatedAt: new Date().toISOString(),
      ...metadata,
    });
  }

  async loadManifest(n: number, d: number): Promise<VideoManifest | undefined> {
    try {
      return VideoManifestSchema.parse(
        JSON.parse(await readFile(resolve(this.videoDir(n, d), 'manifest.json'), 'utf8')),
      );
    } catch {
      return undefined;
    }
  }

  async saveManifest(n: number, d: number, m: VideoManifest): Promise<string> {
    return atomicJson(resolve(this.videoDir(n, d), 'manifest.json'), VideoManifestSchema.parse(m));
  }

  async saveScript(n: number, d: number, script: unknown): Promise<string> {
    return atomicJson(resolve(this.videoDir(n, d), `script_${d}min.json`), script);
  }

  async acquireLock(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    const lockPath = resolve(this.baseDir, `.job_${this.jobId}.lock`);
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(
        JSON.stringify({
          jobId: this.jobId,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
        'utf8',
      );
      await handle.close();
      this.lockAcquired = true;
    } catch {
      throw new Error(`Job ${this.jobId} já está em execução no diretório ${this.baseDir}.`);
    }
  }

  async releaseLock(): Promise<void> {
    const lockPath = resolve(this.baseDir, `.job_${this.jobId}.lock`);
    if (this.lockAcquired) {
      await unlink(lockPath).catch(() => {});
      this.lockAcquired = false;
    }
  }
}
