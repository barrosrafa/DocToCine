import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PlannedShot } from '../../domain/schemas/scene.schema.js';
import { SharpSceneProvider } from './sharp-scene-provider.js';

export class ShotCompositor {
  private readonly fallbackCompositor: SharpSceneProvider;

  constructor(
    readonly width = 1920,
    readonly height = 1080,
  ) {
    this.fallbackCompositor = new SharpSceneProvider(this.width, this.height);
  }

  private computeCropRegion(
    srcWidth: number,
    srcHeight: number,
    variantIndex: number,
    cameraMove: PlannedShot['cameraMove'],
  ): { left: number; top: number; width: number; height: number } {
    if (variantIndex === 0 && cameraMove === 'static') {
      return { left: 0, top: 0, width: srcWidth, height: srcHeight };
    }
    // Zoom factor between 84% and 94% of source dimensions to create distinct framing
    const scale = Math.max(0.82, 0.94 - (variantIndex % 3) * 0.04);
    const cropW = Math.max(64, Math.floor(srcWidth * scale));
    const cropH = Math.max(64, Math.floor(srcHeight * scale));
    const maxLeft = Math.max(0, srcWidth - cropW);
    const maxTop = Math.max(0, srcHeight - cropH);

    switch (cameraMove) {
      case 'pan-left':
        return {
          left: Math.floor(maxLeft * 0.2),
          top: Math.floor(maxTop * 0.5),
          width: cropW,
          height: cropH,
        };
      case 'pan-right':
        return {
          left: Math.floor(maxLeft * 0.8),
          top: Math.floor(maxTop * 0.5),
          width: cropW,
          height: cropH,
        };
      case 'pan-up':
        return {
          left: Math.floor(maxLeft * 0.5),
          top: Math.floor(maxTop * 0.2),
          width: cropW,
          height: cropH,
        };
      case 'pan-down':
        return {
          left: Math.floor(maxLeft * 0.5),
          top: Math.floor(maxTop * 0.8),
          width: cropW,
          height: cropH,
        };
      case 'slow-zoom-out':
        return {
          left: Math.floor(maxLeft * 0.35),
          top: Math.floor(maxTop * 0.35),
          width: cropW,
          height: cropH,
        };
      case 'slow-zoom-in':
      default:
        return {
          left: Math.floor(maxLeft * 0.5),
          top: Math.floor(maxTop * 0.5),
          width: cropW,
          height: cropH,
        };
    }
  }

  async composeShot(
    shot: PlannedShot,
    outputPath: string,
    baseImageBuffer?: Buffer,
    variantIndex = 0,
  ): Promise<string> {
    await mkdir(dirname(outputPath), { recursive: true });

    let framedBuffer: Buffer | undefined = baseImageBuffer;
    if (baseImageBuffer) {
      try {
        const meta = await sharp(baseImageBuffer).metadata();
        if (meta.width && meta.height && meta.width >= 120 && meta.height >= 120) {
          const region = this.computeCropRegion(
            meta.width,
            meta.height,
            variantIndex,
            shot.cameraMove,
          );
          framedBuffer = await sharp(baseImageBuffer)
            .extract(region)
            .resize(this.width, this.height, { fit: 'cover' })
            .png()
            .toBuffer();
        }
      } catch {
        framedBuffer = baseImageBuffer;
      }
    }

    return this.fallbackCompositor.create(
      {
        sceneId: shot.shotId,
        segmentIds: shot.sourceSegmentIds,
        visualPrompt: shot.visualPrompt,
        onScreenText: shot.onScreenText,
        durationSeconds: Math.max(1, shot.endSeconds - shot.startSeconds),
        sourcePages: shot.sourcePages,
      },
      outputPath,
      framedBuffer,
    );
  }
}
