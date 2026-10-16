#!/usr/bin/env node
import { resolve } from 'node:path';
import { buildCli } from './cli/build-cli.js';
import { ArtifactStore } from './infra/storage/artifact-store.js';
import { BookPipeline } from './application/pipelines/book-pipeline.js';
import { asError } from './core/errors/app-error.js';
export async function run(argv = process.argv) {
  const cli = buildCli();
  cli.parse(argv);
  const opts = cli.opts<{
    output: string;
    chapters: string;
    durations: string;
    renderVideos?: boolean;
  }>();
  const pdf = cli.args[0] as string;
  try {
    const output = resolve(opts.output);
    const store = new ArtifactStore(output);
    const durations = opts.durations
      .split(',')
      .map(Number)
      .filter((d): d is 1 | 3 | 20 => d === 1 || d === 3 || d === 20);
    if (!durations.length) throw new Error('Informe ao menos uma duração válida: 1, 3 ou 20.');
    const result = await new BookPipeline(store).run(
      resolve(pdf),
      Number(opts.chapters),
      durations,
      Boolean(opts.renderVideos),
    );
    console.log(
      JSON.stringify(
        {
          output,
          chapters: result.packages.length,
          videos: result.videoPaths.length,
          failed: result.failedArtifacts,
        },
        null,
        2,
      ),
    );
    return result.failedArtifacts.length ? 2 : 0;
  } catch (error: unknown) {
    console.error(`lcbooks: ${asError(error).message}`);
    return 1;
  }
}
if (import.meta.url === `file://${process.argv[1]}`)
  run().then((code) => {
    process.exitCode = code;
  });
