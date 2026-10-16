import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { AppError } from '../../core/errors/app-error.js';
import {
  AlignmentResultSchema,
  type AlignmentResult,
  type WordTiming,
} from '../../domain/schemas/alignment.schema.js';
import type {
  AlignmentProvider,
  AlignSegmentInput,
} from '../../domain/ports/alignment-provider.js';
import { ApproximateAligner } from '../../application/services/approximate-aligner.js';

export type PythonRunner = (
  pythonBin: string,
  args: string[],
  stdinPayload: string,
  timeoutMs: number,
) => Promise<string>;

const MAX_STDIO_BYTES = 512 * 1024;

const defaultPythonRunner: PythonRunner = (pythonBin, args, stdinPayload, timeoutMs) =>
  new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(pythonBin, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      rejectPromise(
        new AppError('Timeout no worker Python de forced alignment.', {
          code: 'PROCESS_TIMEOUT',
          stage: 'alignment',
          retryable: false,
        }),
      );
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_STDIO_BYTES) {
        stdout += chunk.toString('utf8');
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDIO_BYTES) {
        stderr += chunk.toString('utf8');
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        rejectPromise(
          new Error(`Worker Python de alinhamento falhou (${code}): ${stderr.slice(0, 400)}`),
        );
      }
    });

    proc.stdin.write(stdinPayload, 'utf8');
    proc.stdin.end();
  });

export type WhisperXAlignerOptions = {
  pythonBin?: string;
  workerPath?: string;
  timeoutMs?: number;
  fallbackToApproximate?: boolean;
  fallbackDurationSeconds?: number;
  runnerImpl?: PythonRunner;
};

export class WhisperXAligner implements AlignmentProvider {
  private readonly pythonBin: string;
  private readonly workerPath: string;
  private readonly timeoutMs: number;
  private readonly fallbackToApproximate: boolean;
  private readonly fallbackDurationSeconds?: number;
  private readonly runner: PythonRunner;
  private readonly approximate = new ApproximateAligner();

  constructor(options: WhisperXAlignerOptions = {}) {
    this.pythonBin = options.pythonBin ?? 'python3';
    this.workerPath = options.workerPath ?? resolve(process.cwd(), 'tools/alignment/worker.py');
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.fallbackToApproximate = options.fallbackToApproximate ?? true;
    if (options.fallbackDurationSeconds !== undefined) {
      this.fallbackDurationSeconds = options.fallbackDurationSeconds;
    }
    this.runner = options.runnerImpl ?? defaultPythonRunner;
  }

  async align(input: {
    audioPath: string;
    transcript: string;
    language: 'pt';
    durationSeconds?: number;
  }): Promise<AlignmentResult> {
    const stdinPayload = JSON.stringify({
      audioPath: input.audioPath,
      transcript: input.transcript,
      language: input.language,
    });

    try {
      const rawOut = await this.runner(
        this.pythonBin,
        [this.workerPath, '--audio', input.audioPath, '--language', input.language],
        stdinPayload,
        this.timeoutMs,
      );

      const parsed = JSON.parse(rawOut) as {
        words?: WordTiming[];
        warnings?: string[];
        error?: string;
      };
      if (parsed.error) {
        throw new Error(parsed.error);
      }

      return AlignmentResultSchema.parse({
        words: parsed.words ?? [],
        method: 'forced-alignment',
        warnings: parsed.warnings ?? [],
      });
    } catch (err: unknown) {
      if (!this.fallbackToApproximate) {
        throw new AppError(
          `Forced alignment falhou: ${err instanceof Error ? err.message : String(err)}`,
          { code: 'ALIGNMENT_FAILED', stage: 'alignment', cause: err },
        );
      }
      const approxDuration = input.durationSeconds ?? this.fallbackDurationSeconds;
      const fallback = await this.approximate.align({
        audioPath: input.audioPath,
        transcript: input.transcript,
        language: input.language,
        ...(approxDuration !== undefined ? { durationSeconds: approxDuration } : {}),
      });
      return {
        ...fallback,
        warnings: [
          `WhisperX forced alignment indisponível (${err instanceof Error ? err.message : String(err)}); usando phrase-estimate.`,
          ...fallback.warnings,
        ],
      };
    }
  }

  async alignSegments(segments: AlignSegmentInput[]): Promise<AlignmentResult> {
    return this.approximate.alignSegments(segments);
  }
}
