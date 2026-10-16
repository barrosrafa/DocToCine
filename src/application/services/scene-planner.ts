import {
  PlannedShotSchema,
  ShotPlanSchema,
  StyleBibleSchema,
  type CameraMove,
  type PlannedShot,
  type ShotKind,
  type ShotPlan,
  type VisualMode,
} from '../../domain/schemas/scene.schema.js';
import type { VideoScript } from '../../domain/schemas/script.schema.js';

export type TimedSegmentInput = {
  segmentId: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export type ScenePlannerOptions = {
  targetShotSeconds?: number;
  aiImageMinIntervalSeconds?: number;
  maxGeneratedImagesPerVideo?: number;
  visualMode?: VisualMode;
  aspectRatio?: '16:9' | '9:16';
};

const SHOT_KIND_CYCLE: ShotKind[] = [
  'establishing',
  'character',
  'detail',
  'symbolic',
  'diagram',
  'quote-card',
  'transition',
  'recap',
];

const CAMERA_MOVE_CYCLE: CameraMove[] = [
  'slow-zoom-in',
  'pan-right',
  'slow-zoom-out',
  'pan-left',
  'pan-up',
  'pan-down',
  'static',
];

function splitTextIntoSentenceParts(text: string, desiredCount: number): string[] {
  if (desiredCount <= 1) return [text.trim()];
  const sentences = text
    .split(/(?<=[.!?…;])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length >= desiredCount) {
    const out: string[] = [];
    const perBucket = sentences.length / desiredCount;
    for (let i = 0; i < desiredCount; i++) {
      const start = Math.floor(i * perBucket);
      const end = i === desiredCount - 1 ? sentences.length : Math.floor((i + 1) * perBucket);
      const chunk = sentences.slice(start, Math.max(start + 1, end)).join(' ');
      if (chunk) out.push(chunk);
    }
    return out.length > 0 ? out : [text.trim()];
  }

  // Fallback to splitting by clauses/words on natural boundaries
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 4) return [text.trim()];

  const actualCount = Math.min(desiredCount, Math.max(1, Math.floor(words.length / 4)));
  const out: string[] = [];
  const wordsPerPart = words.length / actualCount;
  for (let i = 0; i < actualCount; i++) {
    const start = Math.floor(i * wordsPerPart);
    const end = i === actualCount - 1 ? words.length : Math.floor((i + 1) * wordsPerPart);
    const slice = words.slice(start, Math.max(start + 1, end)).join(' ');
    if (slice) out.push(slice);
  }
  return out.length > 0 ? out : [text.trim()];
}

export function planVideoShots(
  script: VideoScript,
  timedSegments: TimedSegmentInput[],
  options: ScenePlannerOptions = {},
): ShotPlan {
  const visualMode: VisualMode = options.visualMode ?? 'balanced';
  const modeDefaultTarget = visualMode === 'dynamic' ? 7 : visualMode === 'economic' ? 13 : 8;
  const targetShotSeconds = Math.max(3, options.targetShotSeconds ?? modeDefaultTarget);
  const aiImageMinIntervalSeconds = Math.max(
    4,
    options.aiImageMinIntervalSeconds ?? (visualMode === 'economic' ? 28 : 18),
  );
  const maxGeneratedImages = Math.max(0, options.maxGeneratedImagesPerVideo ?? 80);
  const aspectRatio = options.aspectRatio ?? '16:9';

  const styleBible = StyleBibleSchema.parse({
    version: 'v2.0',
    palette: script.tone === 'documental' ? 'editorial-slate-gold' : 'cinematic-amber-slate',
    era: 'atemporal',
    illustrationStyle:
      'Ilustração cinematográfica digital atmosférica de alta definição, composição de direção de arte',
    lighting: 'Iluminação dramática chiaroscuro e luz volumétrica suave',
    aspectRatio,
    negativeConstraints:
      'Sem textos, sem letras, sem números escritos, sem logotipos ou marcas d’água',
  });

  const shots: PlannedShot[] = [];
  const warnings: string[] = [];
  let aiGeneratedSoFar = 0;
  let lastAiGenerationTime = -Infinity;
  let currentAssetKey = 'asset_001';
  let currentVariantIndex = 0;

  const segmentsToPlan: TimedSegmentInput[] =
    timedSegments.length > 0
      ? timedSegments
      : script.segments.map((s, idx) => {
          const dur = Math.max(4, s.text.split(/\s+/).length / 2.25);
          const start = idx * dur;
          return {
            segmentId: s.id,
            text: s.text,
            startSeconds: start,
            endSeconds: start + dur,
          };
        });

  let globalCursor = 0;

  for (let segIdx = 0; segIdx < segmentsToPlan.length; segIdx++) {
    const timed = segmentsToPlan[segIdx]!;
    const scriptSeg =
      script.segments.find((s) => s.id === timed.segmentId) ?? script.segments[segIdx];
    const segStart = Math.max(globalCursor, timed.startSeconds);
    const segEnd = Math.max(segStart + 1.0, timed.endSeconds);
    const segDuration = segEnd - segStart;

    const numSubShots = Math.max(1, Math.round(segDuration / targetShotSeconds));
    const textParts = splitTextIntoSentenceParts(timed.text, numSubShots);
    const totalCharWeight = textParts.reduce((acc, part) => acc + Math.max(1, part.length), 0) || 1;

    let subCursor = segStart;
    const basePrompt =
      scriptSeg?.sceneHint ||
      script.bRollAndVisuals[segIdx % Math.max(1, script.bRollAndVisuals.length)] ||
      script.title ||
      'Cena cinematográfica documental';
    const baseOnScreen =
      scriptSeg?.onScreenText ||
      script.beats[segIdx % Math.max(1, script.beats.length)] ||
      script.title;
    const sourcePages =
      scriptSeg?.sourcePages && scriptSeg.sourcePages.length > 0
        ? scriptSeg.sourcePages
        : script.sourcePages;

    for (let pIdx = 0; pIdx < textParts.length; pIdx++) {
      const partText = textParts[pIdx]!;
      const isLastInSeg = pIdx === textParts.length - 1;
      const weightRatio = Math.max(1, partText.length) / totalCharWeight;
      const rawDur = segDuration * weightRatio;

      const shotStart = Number(subCursor.toFixed(3));
      const shotEnd = isLastInSeg
        ? Number(segEnd.toFixed(3))
        : Number(Math.max(shotStart + 0.8, Math.min(segEnd - 0.4, shotStart + rawDur)).toFixed(3));

      const shotIndex = shots.length;
      const shotId = `shot_${String(shotIndex + 1).padStart(3, '0')}`;
      const kind: ShotKind =
        shotIndex === 0
          ? 'establishing'
          : shotIndex === segmentsToPlan.length * textParts.length - 1
            ? 'recap'
            : SHOT_KIND_CYCLE[shotIndex % SHOT_KIND_CYCLE.length]!;
      const cameraMove: CameraMove = CAMERA_MOVE_CYCLE[shotIndex % CAMERA_MOVE_CYCLE.length]!;

      const canGenerateNewAi =
        aiGeneratedSoFar < maxGeneratedImages &&
        (shotIndex === 0 ||
          pIdx === 0 ||
          shotStart - lastAiGenerationTime >= aiImageMinIntervalSeconds);

      if (canGenerateNewAi) {
        aiGeneratedSoFar++;
        lastAiGenerationTime = shotStart;
        currentAssetKey = `asset_${String(aiGeneratedSoFar).padStart(3, '0')}`;
        currentVariantIndex = 0;
      } else {
        currentVariantIndex++;
      }

      const shotDetailHint =
        pIdx === 0
          ? basePrompt
          : `${basePrompt} — enquadramento ${kind} focado em: ${partText.slice(0, 90)}`;

      const onScreenSnippet =
        pIdx === 0 ? baseOnScreen.slice(0, 140) : partText.split(/[,.;!?]/)[0]!.slice(0, 100);

      shots.push(
        PlannedShotSchema.parse({
          shotId,
          sourceSegmentIds: [timed.segmentId],
          startSeconds: shotStart,
          endSeconds: Math.max(shotStart + 0.2, shotEnd),
          visualPrompt:
            `${shotDetailHint}. Estilo: ${styleBible.illustrationStyle}, ${styleBible.lighting}. ${styleBible.negativeConstraints}.`.slice(
              0,
              2400,
            ),
          onScreenText: onScreenSnippet.slice(0, 160),
          kind,
          cameraMove,
          assetKey: currentAssetKey,
          generatedByAi: canGenerateNewAi,
          variantIndex: currentVariantIndex,
          sourcePages,
        }),
      );

      subCursor = Math.max(shotStart + 0.2, shotEnd);
    }

    globalCursor = subCursor;
  }

  const totalDurationSeconds = Math.max(1, shots.at(-1)?.endSeconds ?? 1);
  return ShotPlanSchema.parse({
    schemaVersion: 2,
    visualMode,
    styleBible,
    totalDurationSeconds,
    plannedAiImageCount: aiGeneratedSoFar,
    shots,
    warnings,
  });
}
