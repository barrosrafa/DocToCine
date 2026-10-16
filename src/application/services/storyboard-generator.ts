import type { VideoScript } from '../../domain/schemas/script.schema.js';
import type { ChapterBoundary } from '../../domain/schemas/chapter.schema.js';
import { StoryboardSceneSchema, type StoryboardScene } from '../../domain/schemas/video.schema.js';
import {
  planVideoShots,
  type ScenePlannerOptions,
  type TimedSegmentInput,
} from './scene-planner.js';

export function createStoryboard(
  script: VideoScript,
  chapter: ChapterBoundary,
  timedSegments?: TimedSegmentInput[],
  options?: ScenePlannerOptions,
): StoryboardScene[] {
  if (timedSegments && timedSegments.length > 0) {
    const plan = planVideoShots(script, timedSegments, options);
    return plan.shots.map((shot) =>
      StoryboardSceneSchema.parse({
        sceneId: shot.shotId,
        segmentIds: shot.sourceSegmentIds,
        visualPrompt: shot.visualPrompt,
        onScreenText: shot.onScreenText,
        durationSeconds: Math.max(0.5, shot.endSeconds - shot.startSeconds),
        sourcePages: shot.sourcePages.length
          ? shot.sourcePages
          : Array.from(
              { length: chapter.endPage - chapter.startPage + 1 },
              (_, n) => chapter.startPage + n,
            ),
      }),
    );
  }

  return script.segments.map((s, i) =>
    StoryboardSceneSchema.parse({
      sceneId: `scene_${String(i + 1).padStart(3, '0')}`,
      segmentIds: [s.id],
      visualPrompt: s.sceneHint || chapter.title,
      onScreenText: s.onScreenText,
      durationSeconds: Math.max(1, s.text.split(/\s+/).length / 2.3),
      sourcePages: s.sourcePages.length
        ? s.sourcePages
        : [...Array(chapter.endPage - chapter.startPage + 1)].map((_, n) => chapter.startPage + n),
    }),
  );
}
