#!/usr/bin/env node
import { resolve } from 'node:path';
import { buildCli } from './cli/build-cli.js';
import { ArtifactStore } from './infra/storage/artifact-store.js';
import { BookPipeline } from './application/pipelines/book-pipeline.js';
import { VideoPipeline } from './application/pipelines/video-pipeline.js';
import { OpenRouterLlmProvider } from './infra/llm/openrouter-provider.js';
import { OpenRouterTtsProvider } from './infra/tts/openrouter-tts-provider.js';
import { FakeTtsProvider } from './infra/tts/fake-tts-provider.js';
import { OpenRouterSceneProvider } from './infra/media/openrouter-scene-provider.js';
import { SharpSceneProvider } from './infra/media/sharp-scene-provider.js';
import { loadSettings } from './config/settings.js';
import { asError } from './core/errors/app-error.js';

export async function run(argv = process.argv) {
  const cli = buildCli();
  cli.parse(argv);
  const opts = cli.opts<{
    output: string;
    chapters: string;
    durations: string;
    renderVideos?: boolean;
    aspectRatio?: string;
  }>();
  const pdf = cli.args[0] as string;
  try {
    const settings = loadSettings();
    const output = resolve(opts.output);
    const store = new ArtifactStore(output);
    const durations = opts.durations
      .split(',')
      .map(Number)
      .filter((d): d is 1 | 3 | 20 => d === 1 || d === 3 || d === 20);
    if (!durations.length) throw new Error('Informe ao menos uma duração válida: 1, 3 ou 20.');

    const [width, height] =
      opts.aspectRatio === '9:16'
        ? [settings.VIDEO_HEIGHT, settings.VIDEO_WIDTH]
        : [settings.VIDEO_WIDTH, settings.VIDEO_HEIGHT];

    const apiKey = settings.OPENROUTER_API_KEY;

    const sceneProvider =
      settings.SCENE_PROVIDER === 'openrouter' && apiKey
        ? new OpenRouterSceneProvider({
            apiKey,
            baseUrl: settings.OPENROUTER_BASE_URL,
            model: settings.OPENROUTER_IMAGE_MODEL,
            width,
            height,
            timeoutMs: settings.OPENROUTER_TIMEOUT_MS,
          })
        : new SharpSceneProvider(width, height);

    const ttsProvider =
      settings.TTS_PROVIDER === 'openrouter' && apiKey
        ? new OpenRouterTtsProvider({
            apiKey,
            baseUrl: settings.OPENROUTER_BASE_URL,
            model: settings.OPENROUTER_AUDIO_MODEL,
            voice: settings.TTS_VOICE,
            timeoutMs: settings.OPENROUTER_TIMEOUT_MS,
          })
        : new FakeTtsProvider();

    const video = new VideoPipeline(
      store,
      width,
      height,
      settings.BURN_CAPTIONS,
      sceneProvider,
      ttsProvider,
    );

    const llm = apiKey
      ? new OpenRouterLlmProvider({
          apiKey,
          baseUrl: settings.OPENROUTER_BASE_URL,
          appUrl: settings.OPENROUTER_APP_URL,
          appTitle: settings.OPENROUTER_APP_TITLE,
          summaryModel: settings.OPENROUTER_SUMMARY_MODEL,
          scriptModel: settings.OPENROUTER_SCRIPT_MODEL,
          storyboardModel: settings.OPENROUTER_STORYBOARD_MODEL,
          fallbackModels: settings.OPENROUTER_FALLBACK_MODELS,
          timeoutMs: settings.OPENROUTER_TIMEOUT_MS,
          maxRetries: settings.MAX_RETRY_ATTEMPTS,
        })
      : undefined;

    const result = await new BookPipeline(
      store,
      video,
      llm,
      settings.LLM_CONCURRENCY,
      settings.MAX_CHAPTER_CHARS_PER_CHUNK,
    ).run(resolve(pdf), Number(opts.chapters), durations, Boolean(opts.renderVideos));
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
