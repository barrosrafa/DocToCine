import { access, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { QualityReportSchema, type QualityReport } from '../../domain/schemas/video.schema.js';
function probe(path: string): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    const p = spawn(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path],
      { shell: false },
    );
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', rej);
    p.on('close', (c) =>
      c === 0 ? res(JSON.parse(out) as Record<string, unknown>) : rej(new Error('ffprobe falhou')),
    );
  });
}
export async function checkVideo(
  path: string,
  expected: { width: number; height: number },
): Promise<QualityReport> {
  const errors: string[] = [];
  try {
    await access(path);
    if ((await stat(path)).size < 100) errors.push('MP4 vazio ou muito pequeno.');
  } catch {
    errors.push('MP4 inexistente.');
  }
  let data: Record<string, unknown> = {};
  if (!errors.length)
    try {
      data = await probe(path);
    } catch (e) {
      errors.push(String(e));
    }
  const streams = Array.isArray(data.streams) ? (data.streams as Record<string, unknown>[]) : [];
  const video = streams.find((s) => s.codec_type === 'video'),
    audio = streams.find((s) => s.codec_type === 'audio');
  if (!video) errors.push('Stream de vídeo ausente.');
  if (!audio) errors.push('Stream de áudio ausente.');
  if (
    video &&
    ((video.width as number) !== expected.width || (video.height as number) !== expected.height)
  )
    errors.push('Resolução inesperada.');
  const duration = Number((data.format as Record<string, unknown> | undefined)?.duration ?? 0);
  return QualityReportSchema.parse({
    passed: errors.length === 0,
    videoCodec: String(video?.codec_name ?? ''),
    audioCodec: String(audio?.codec_name ?? ''),
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
    fps: 0,
    durationSeconds: duration,
    hasAudio: Boolean(audio),
    errors,
  });
}
