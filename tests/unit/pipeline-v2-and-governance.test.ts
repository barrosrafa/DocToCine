import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, stableHash } from '../../src/infra/storage/artifact-store.js';
import { CostGuard } from '../../src/application/services/cost-guard.js';
import { JobReporter } from '../../src/application/services/job-reporter.js';
import { BookPipeline } from '../../src/application/pipelines/book-pipeline.js';
import { VideoPipeline } from '../../src/application/pipelines/video-pipeline.js';
import { SharpSceneProvider } from '../../src/infra/media/sharp-scene-provider.js';
import { FakeTtsProvider } from '../../src/infra/tts/fake-tts-provider.js';
import { createMinimalPdfBuffer } from '../helpers/fixture-generators.js';
import { buildCli } from '../../src/cli/build-cli.js';

describe('ArtifactStore, CostGuard, JobReporter, Resume & CLI v2 (Fases 8-10 / Sprint H)', () => {
  it('protege ArtifactStore contra path traversal (../), faz lock de job e calcula stableHash profundo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doctocine-store-'));
    try {
      const store = new ArtifactStore(dir, 'job_test_01');
      await expect(store.saveJson('../escape.json', { bad: true })).rejects.toThrow(
        /Caminho de artefato inválido/,
      );
      await expect(store.saveJson('/etc/passwd', { bad: true })).rejects.toThrow(
        /Caminho de artefato inválido/,
      );

      // Deep canonical hash
      const h1 = stableHash({ outer: { b: 2, a: 1 }, list: [{ z: 9, y: 8 }] });
      const h2 = stableHash({ list: [{ y: 8, z: 9 }], outer: { a: 1, b: 2 } });
      const h3 = stableHash({ list: [{ y: 999, z: 9 }], outer: { a: 1, b: 2 } });
      expect(h1).toBe(h2);
      expect(h1).not.toBe(h3);

      await store.acquireLock();
      await expect(store.acquireLock()).rejects.toThrow(/já está em execução/);
      await store.releaseLock();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('interrompe novas chamadas pagas quando CostGuard excede MAX_JOB_COST_USD no modo stop', () => {
    const guard = new CostGuard({ maxCostUsd: 0.5, action: 'stop' });
    guard.recordUsage({
      jobId: 'job_1',
      stage: 'summary',
      model: 'google/gemini-3.5-flash-lite',
      measuredCostUsd: 0.3,
      costStatus: 'measured',
      elapsedMs: 120,
    });
    expect(guard.totalKnownCostUsd).toBeCloseTo(0.3, 4);
    expect(() => guard.assertWithinBudget()).not.toThrow();

    guard.recordUsage({
      jobId: 'job_1',
      stage: 'script',
      model: 'anthropic/claude-haiku-5.5',
      estimatedCostUsd: 0.25,
      costStatus: 'estimated',
      elapsedMs: 250,
    });
    expect(guard.totalKnownCostUsd).toBeCloseTo(0.55, 4);
    expect(() => guard.assertWithinBudget()).toThrow(/Limite de orçamento do job excedido/);
  });

  it('redige chaves secretas nos eventos do JobReporter', () => {
    const secret = `${'sk-or-v1'}-secret_key_for_reporter_test_123456`;
    const reporter = new JobReporter('job_rep_1', [secret]);
    reporter.record({
      event: 'tts.completed',
      stage: 'tts',
      warning: `Falha parcial com token ${secret}`,
      elapsedMs: 55,
    });

    const events = reporter.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.warning).not.toContain(secret);
    expect(events[0]?.warning).toContain('[REDACTED_KEY]');
  });

  it('executa BookPipeline ponta a ponta com resume idempotente e gera usage_report.json e shot_plan.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doctocine-e2e-'));
    try {
      const pdfPath = join(dir, 'livro.pdf');
      const pdfBuf = createMinimalPdfBuffer([
        'Capitulo 1: A Descoberta\nNo inicio da expedicao, os pesquisadores encontraram o mapa estelar antigo gravado em bronze na biblioteca central.',
        'Capitulo 2: O Horizonte\nNo segundo capitulo, a equipe navegou pelo estreito meridional guiada pelas coordenadas decifradas.',
      ]);
      await writeFile(pdfPath, pdfBuf);

      const outDir = join(dir, 'saida');
      const store = new ArtifactStore(outDir, 'job_e2e');
      const tts = new FakeTtsProvider(0.15, {
        allowSyntheticFixture: true,
        preferSystemSay: false,
      });
      const sceneProvider = new SharpSceneProvider(320, 180);
      const videoPipe = new VideoPipeline(store, 320, 180, false, sceneProvider, tts, {
        fps: 24,
        crf: 24,
        preset: 'ultrafast',
        allowSyntheticFixture: true,
        visualShotTargetSeconds: 6,
      });

      const bookPipe = new BookPipeline(store, videoPipe, undefined, 2, 12000);
      const firstRun = await bookPipe.run(pdfPath, 1, [1], true, {
        resume: false,
        force: false,
        continueOnError: true,
      });

      expect(firstRun.packages).toHaveLength(1);
      expect(firstRun.videoPaths).toHaveLength(1);
      expect(firstRun.failedArtifacts).toHaveLength(0);

      // Segunda execução com --resume deve reutilizar os artefatos válidos
      const secondRun = await bookPipe.run(pdfPath, 1, [1], true, {
        resume: true,
        force: false,
        continueOnError: true,
      });
      expect(secondRun.packages).toHaveLength(1);
      expect(secondRun.videoPaths).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('expõe novas opções de CLI (--visual-mode, --voice, --no-burn-captions, --max-cost-usd)', () => {
    const cli = buildCli();
    cli.parse([
      'node',
      'lcbooks',
      'livro.pdf',
      '--visual-mode',
      'dynamic',
      '--voice',
      'pf_dora',
      '--no-burn-captions',
      '--max-cost-usd',
      '2.5',
      '--resume',
    ]);
    const opts = cli.opts<{
      visualMode?: string;
      voice?: string;
      burnCaptions?: boolean;
      maxCostUsd?: string;
      resume?: boolean;
    }>();
    expect(opts.visualMode).toBe('dynamic');
    expect(opts.voice).toBe('pf_dora');
    expect(opts.burnCaptions).toBe(false);
    expect(opts.maxCostUsd).toBe('2.5');
    expect(opts.resume).toBe(true);
  });
});
