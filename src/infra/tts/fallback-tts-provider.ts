import { join } from 'node:path';
import { AppError } from '../../core/errors/app-error.js';
import type {
  TimedSpeech,
  TtsProvider,
  TtsRequest,
  TtsSegmentResult,
  TtsSegmentsSynthesisResult,
} from '../../domain/ports/tts-provider.js';

export class FallbackTtsProvider implements TtsProvider {
  constructor(
    private readonly primary: TtsProvider,
    private readonly secondary?: TtsProvider,
  ) {}

  async synthesizeRequest(request: TtsRequest): Promise<TtsSegmentResult> {
    try {
      if (this.primary.synthesizeRequest) {
        return await this.primary.synthesizeRequest(request);
      }
      const r = await this.primary.synthesize(request.text, request.outputPath);
      return {
        segmentId: request.idempotencyKey,
        path: r.path,
        durationSeconds: r.duration,
        provider: 'primary',
        model: r.model ?? 'primary',
        voice: r.voice ?? request.voice,
        bytes: 0,
        degraded: Boolean(r.degraded),
      };
    } catch (primaryErr: unknown) {
      if (primaryErr instanceof AppError && primaryErr.code === 'LLM_AUTH') {
        throw primaryErr;
      }
      if (!this.secondary) {
        throw primaryErr;
      }
      const fallbackReason = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);

      if (this.secondary.synthesizeRequest) {
        const secRes = await this.secondary.synthesizeRequest(request);
        return {
          ...secRes,
          degraded: true,
          fallbackReason,
        };
      }

      const secSimple = await this.secondary.synthesize(request.text, request.outputPath);
      return {
        segmentId: request.idempotencyKey,
        path: secSimple.path,
        durationSeconds: secSimple.duration,
        provider: 'fallback',
        model: secSimple.model ?? 'fallback',
        voice: secSimple.voice ?? request.voice,
        bytes: 0,
        degraded: true,
        fallbackReason,
      };
    }
  }

  async synthesize(
    text: string,
    path: string,
  ): Promise<{
    path: string;
    duration: number;
    degraded?: boolean;
    model?: string;
    voice?: string;
  }> {
    const res = await this.synthesizeRequest({
      text,
      outputPath: path,
      language: 'pt-BR',
      voice: 'default',
      speed: 1.0,
      idempotencyKey: path,
    });
    return {
      path: res.path,
      duration: res.durationSeconds,
      degraded: res.degraded,
      model: res.model,
      voice: res.voice,
    };
  }

  async synthesizeSegments(
    segments: { id: string; text: string }[],
    dir: string,
  ): Promise<TtsSegmentsSynthesisResult> {
    let cursor = 0;
    const timed: TimedSpeech[] = [];
    const usedModels = new Set<string>();
    const warnings: string[] = [];
    let anyDegraded = false;

    for (const seg of segments) {
      const outPath = join(dir, `${seg.id}.mp3`);
      const res = await this.synthesizeRequest({
        text: seg.text,
        outputPath: outPath,
        language: 'pt-BR',
        voice: '',
        speed: 1.0,
        idempotencyKey: seg.id,
      });
      if (res.degraded) {
        anyDegraded = true;
        if (res.fallbackReason) {
          warnings.push(
            `Segmento ${seg.id} usou fallback TTS (${res.model}): ${res.fallbackReason}`,
          );
        }
      }
      usedModels.add(res.model);
      timed.push({
        segmentId: seg.id,
        text: seg.text,
        startSeconds: cursor,
        endSeconds: cursor + res.durationSeconds,
        path: res.path,
        model: res.model,
        voice: res.voice,
        degraded: res.degraded,
      });
      cursor += res.durationSeconds;
    }

    return {
      timed,
      duration: cursor,
      degraded: anyDegraded,
      usedModels: [...usedModels],
      warnings,
    };
  }
}
