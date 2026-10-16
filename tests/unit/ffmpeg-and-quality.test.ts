import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  escapeFfmpegFilterPath,
  escapeConcatFilePath,
  buildSubtitleFilterExpression,
} from '../../src/infra/media/ffmpeg-paths.js';
import { FfmpegRenderer } from '../../src/infra/media/ffmpeg-renderer.js';
import { checkVideo, parseFrameRate } from '../../src/infra/media/video-quality-checker.js';
import { createValidWavBuffer } from '../helpers/fixture-generators.js';
import { writeSrt } from '../../src/infra/media/srt-builder.js';
import { writeFile } from 'node:fs/promises';

describe('ffmpeg-paths, FfmpegRenderer & VideoQualityChecker (Fase 7 / Sprint G)', () => {
  it('escapa caminhos com espaços, dois-pontos, aspas e colchetes para filtros subtitles/ass do FFmpeg', () => {
    const trickyPath = "/Users/test/My Videos: Cap'1 [v2]/captions.srt";
    const escaped = escapeFfmpegFilterPath(trickyPath);
    expect(escaped).toContain('\\:');
    expect(escaped).toContain("\\'");
    expect(escaped).toContain('\\[');
    expect(escaped).toContain('\\]');

    const filterAss = buildSubtitleFilterExpression('/tmp/dir:1/captions.ass');
    expect(filterAss.startsWith("ass='")).toBe(true);

    const filterSrt = buildSubtitleFilterExpression('/tmp/dir:1/captions.srt');
    expect(filterSrt.startsWith("subtitles='")).toBe(true);

    const concatEscaped = escapeConcatFilePath("/tmp/scene'01.png");
    expect(concatEscaped).toBe("/tmp/scene'\\''01.png");
  });

  it('parseia frame rate do ffprobe (ex: 30/1, 2997/100) com precisão', () => {
    expect(parseFrameRate('30/1')).toBe(30);
    expect(parseFrameRate('60000/1001')).toBeCloseTo(59.94, 2);
    expect(parseFrameRate('0/0')).toBe(0);
  });

  it('renderiza MP4 real com FfmpegRenderer (+faststart, yuv420p) e audita FPS, delta de duração e legendas no checkVideo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doctocine-render-qa-'));
    try {
      const img1 = join(dir, 'shot_01.png');
      const img2 = join(dir, 'shot_02.png');
      await sharp({
        create: { width: 320, height: 180, channels: 3, background: { r: 30, g: 60, b: 120 } },
      })
        .png()
        .toFile(img1);
      await sharp({
        create: { width: 320, height: 180, channels: 3, background: { r: 80, g: 30, b: 90 } },
      })
        .png()
        .toFile(img2);

      const audioPath = join(dir, 'narration.wav');
      await writeFile(audioPath, createValidWavBuffer(2.0, 16000));

      const srtPath = join(dir, 'captions.srt');
      await writeSrt(
        [
          {
            id: 1,
            startSeconds: 0.0,
            endSeconds: 0.9,
            text: 'Primeiro plano de teste',
            words: ['Primeiro', 'plano', 'de', 'teste'],
          },
          {
            id: 2,
            startSeconds: 0.95,
            endSeconds: 1.9,
            text: 'Segundo plano sincronizado',
            words: ['Segundo', 'plano', 'sincronizado'],
          },
        ],
        srtPath,
      );

      const outMp4 = join(dir, 'video.mp4');
      const renderer = new FfmpegRenderer({
        width: 320,
        height: 180,
        fps: 24,
        crf: 23,
        preset: 'ultrafast',
        burnCaptions: false,
      });

      await renderer.render(
        [
          { imagePath: img1, durationSeconds: 1.0 },
          { imagePath: img2, durationSeconds: 1.0 },
        ],
        audioPath,
        outMp4,
        srtPath,
      );

      const st = await stat(outMp4);
      expect(st.size).toBeGreaterThan(500);

      const report = await checkVideo(outMp4, {
        width: 320,
        height: 180,
        expectedDurationSeconds: 2.0,
        maxDurationDeltaSeconds: 0.5,
        captionsPath: srtPath,
        alignmentMethod: 'forced-alignment',
        ttsDegraded: false,
      });

      expect(report.passed).toBe(true);
      expect(report.width).toBe(320);
      expect(report.height).toBe(180);
      expect(report.fps).toBeCloseTo(24, 0);
      expect(report.hasAudio).toBe(true);
      expect(report.captionFileValid).toBe(true);
      expect(report.captionOverlapCount).toBe(0);
      expect(report.durationDeltaSeconds).toBeLessThanOrEqual(0.5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
