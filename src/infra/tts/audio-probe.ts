import { stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { AppError } from '../../core/errors/app-error.js';

export type AudioProbeResult = {
  valid: boolean;
  durationSeconds: number;
  codecName: string;
  sampleRate: number;
  channels: number;
  bytes: number;
};

const MAX_STDIO_BYTES = 128 * 1024;

export async function probeAudioFile(
  path: string,
  options: { minBytes?: number; timeoutMs?: number } = {},
): Promise<AudioProbeResult> {
  const minBytes = options.minBytes ?? 128;
  const timeoutMs = options.timeoutMs ?? 15000;

  let fileStat;
  try {
    fileStat = await stat(path);
  } catch (err) {
    throw new AppError(`Arquivo de áudio não encontrado: ${path}`, {
      code: 'AUDIO_INVALID',
      stage: 'audio',
      cause: err,
    });
  }

  if (fileStat.size < minBytes) {
    throw new AppError(
      `Arquivo de áudio inválido ou truncado (${fileStat.size} bytes < ${minBytes} bytes).`,
      { code: 'AUDIO_INVALID', stage: 'audio' },
    );
  }

  const rawJson = await new Promise<string>((resolve, reject) => {
    const proc = spawn(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=codec_name,codec_type,sample_rate,channels',
        '-of',
        'json',
        path,
      ],
      { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(
        new AppError(`Timeout ao executar ffprobe em ${path}`, {
          code: 'PROCESS_TIMEOUT',
          stage: 'audio',
          retryable: true,
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
      reject(
        new AppError(`Falha ao iniciar ffprobe: ${err.message}`, {
          code: 'FFMPEG_MISSING',
          stage: 'audio',
          cause: err,
        }),
      );
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new AppError(`ffprobe rejeitou o áudio (${code}): ${stderr.slice(0, 300)}`, {
            code: 'AUDIO_INVALID',
            stage: 'audio',
          }),
        );
      }
    });
  });

  let parsed: {
    streams?: {
      codec_type?: string;
      codec_name?: string;
      sample_rate?: string | number;
      channels?: number;
    }[];
    format?: { duration?: string | number };
  };
  try {
    parsed = JSON.parse(rawJson) as typeof parsed;
  } catch (err) {
    throw new AppError('Saída JSON inválida do ffprobe.', {
      code: 'AUDIO_INVALID',
      stage: 'audio',
      cause: err,
    });
  }

  const audioStream = (parsed.streams ?? []).find((s) => s.codec_type === 'audio');
  if (!audioStream) {
    throw new AppError('Nenhum stream de áudio válido encontrado no arquivo.', {
      code: 'AUDIO_INVALID',
      stage: 'audio',
    });
  }

  const durationSeconds = Number(parsed.format?.duration ?? 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new AppError(`Duração de áudio inválida retornada pelo ffprobe: ${durationSeconds}`, {
      code: 'AUDIO_INVALID',
      stage: 'audio',
    });
  }

  return {
    valid: true,
    durationSeconds,
    codecName: String(audioStream.codec_name ?? 'unknown'),
    sampleRate: Number(audioStream.sample_rate ?? 0),
    channels: Number(audioStream.channels ?? 1),
    bytes: fileStat.size,
  };
}
