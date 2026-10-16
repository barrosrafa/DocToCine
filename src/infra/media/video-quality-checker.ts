import { access, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { QualityReportSchema, type QualityReport } from '../../domain/schemas/video.schema.js';
import type { AlignmentMethod } from '../../domain/schemas/alignment.schema.js';
import { parseSrtCues } from './srt-builder.js';

function probe(path: string, timeoutMs = 20000): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    const p = spawn(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path],
      { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      rej(new Error('Timeout no ffprobe durante checkVideo'));
    }, timeoutMs);

    p.stdout.on('data', (d) => {
      if (out.length < 256 * 1024) out += String(d);
    });
    p.on('error', (err) => {
      clearTimeout(timer);
      rej(err);
    });
    p.on('close', (c) => {
      clearTimeout(timer);
      if (c === 0) {
        try {
          res(JSON.parse(out) as Record<string, unknown>);
        } catch (err) {
          rej(err);
        }
      } else {
        rej(new Error('ffprobe falhou'));
      }
    });
  });
}

export function parseFrameRate(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return 0;
  if (raw.includes('/')) {
    const [numStr, denStr] = raw.split('/');
    const num = Number(numStr);
    const den = Number(denStr);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return Number((num / den).toFixed(3));
    }
    return 0;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type VideoQualityExpectations = {
  width: number;
  height: number;
  expectedDurationSeconds?: number;
  maxDurationDeltaSeconds?: number;
  captionsPath?: string;
  alignmentMethod?: AlignmentMethod;
  ttsDegraded?: boolean;
  ttsWasSyntheticFixture?: boolean;
  allowSyntheticFixture?: boolean;
};

export async function checkVideo(
  path: string,
  expected: VideoQualityExpectations,
): Promise<QualityReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let fileSizeBytes = 0;

  try {
    await access(path);
    const st = await stat(path);
    fileSizeBytes = st.size;
    if (st.size < 100) errors.push('MP4 vazio ou muito pequeno.');
  } catch {
    errors.push('MP4 inexistente.');
  }

  let data: Record<string, unknown> = {};
  if (!errors.length) {
    try {
      data = await probe(path);
    } catch (e) {
      errors.push(String(e));
    }
  }

  const streams = Array.isArray(data.streams) ? (data.streams as Record<string, unknown>[]) : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  if (!video) errors.push('Stream de vídeo ausente.');
  if (!audio) errors.push('Stream de áudio ausente.');

  if (
    video &&
    ((video.width as number) !== expected.width || (video.height as number) !== expected.height)
  ) {
    errors.push(
      `Resolução inesperada: obtido ${String(video.width)}x${String(video.height)}, esperado ${expected.width}x${expected.height}.`,
    );
  }

  const formatDuration = Number(
    (data.format as Record<string, unknown> | undefined)?.duration ?? 0,
  );
  const videoDurationSeconds = Number(video?.duration ?? formatDuration);
  const audioDurationSeconds = Number(audio?.duration ?? formatDuration);
  const durationSeconds = formatDuration || Math.max(videoDurationSeconds, audioDurationSeconds);

  if (durationSeconds <= 0) {
    errors.push('Duração do vídeo é zero ou inválida.');
  }

  const fps = parseFrameRate(video?.avg_frame_rate) || parseFrameRate(video?.r_frame_rate);

  let durationDeltaSeconds = 0;
  if (expected.expectedDurationSeconds !== undefined && expected.expectedDurationSeconds > 0) {
    durationDeltaSeconds = Number(
      Math.abs(durationSeconds - expected.expectedDurationSeconds).toFixed(3),
    );
    const maxDelta = expected.maxDurationDeltaSeconds ?? 0.6;
    if (durationDeltaSeconds > maxDelta) {
      errors.push(
        `Delta de duração (${durationDeltaSeconds}s) acima do limite permitido (${maxDelta}s).`,
      );
    }
  } else if (videoDurationSeconds > 0 && audioDurationSeconds > 0) {
    durationDeltaSeconds = Number(Math.abs(videoDurationSeconds - audioDurationSeconds).toFixed(3));
  }

  let captionsPresent = false;
  let captionFileValid = true;
  let captionLastEndSeconds = 0;
  let captionOverlapCount = 0;

  if (expected.captionsPath) {
    try {
      await access(expected.captionsPath);
      captionsPresent = true;
      const cues = await parseSrtCues(expected.captionsPath);
      if (cues.length === 0) {
        captionFileValid = false;
        warnings.push('Arquivo de legendas está vazio.');
      } else {
        for (let i = 0; i < cues.length; i++) {
          const cue = cues[i]!;
          const [, start, end] = cue;
          if (end <= start) {
            captionFileValid = false;
            errors.push(`Cue de legenda ${cue[0]} possui duração <= 0.`);
          }
          if (i > 0 && start < cues[i - 1]![2] - 0.01) {
            captionOverlapCount++;
          }
          captionLastEndSeconds = Math.max(captionLastEndSeconds, end);
        }
        if (durationSeconds > 0 && captionLastEndSeconds > durationSeconds + 0.75) {
          captionFileValid = false;
          errors.push(
            `Última legenda (${captionLastEndSeconds.toFixed(2)}s) ultrapassa a duração real do vídeo (${durationSeconds.toFixed(2)}s).`,
          );
        }
      }
    } catch {
      captionFileValid = false;
      errors.push('Arquivo de legendas ausente ou inválido.');
    }
  }

  if (expected.ttsWasSyntheticFixture && !expected.allowSyntheticFixture) {
    errors.push('Vídeo gerado com fixture sintética de TTS sem flag explícita de teste.');
  }

  if (expected.alignmentMethod === 'phrase-estimate') {
    warnings.push('Legendas sincronizadas por estimativa ponderada (phrase-estimate).');
  }
  if (expected.ttsDegraded) {
    warnings.push('Áudio gerado em modo degradado/fallback.');
  }

  return QualityReportSchema.parse({
    schemaVersion: 2,
    passed: errors.length === 0,
    videoCodec: String(video?.codec_name ?? ''),
    audioCodec: String(audio?.codec_name ?? ''),
    pixFmt: String(video?.pix_fmt ?? ''),
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
    fps,
    sampleRate: Number(audio?.sample_rate ?? 0),
    channels: Number(audio?.channels ?? 0),
    fileSizeBytes,
    durationSeconds,
    videoDurationSeconds,
    audioDurationSeconds,
    ...(expected.expectedDurationSeconds !== undefined
      ? { expectedDurationSeconds: expected.expectedDurationSeconds }
      : {}),
    durationDeltaSeconds,
    hasAudio: Boolean(audio),
    captionsPresent,
    captionFileValid,
    captionLastEndSeconds,
    captionOverlapCount,
    ...(expected.alignmentMethod !== undefined
      ? { alignmentMethod: expected.alignmentMethod }
      : {}),
    ttsDegraded: Boolean(expected.ttsDegraded),
    warnings,
    errors,
  });
}
