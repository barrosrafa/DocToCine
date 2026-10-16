import type { VideoScript } from '../../domain/schemas/script.schema.js';
import type { ChapterBoundary } from '../../domain/schemas/chapter.schema.js';
import { StoryboardSceneSchema, type StoryboardScene } from '../../domain/schemas/video.schema.js';
export function createStoryboard(script: VideoScript, chapter: ChapterBoundary): StoryboardScene[] {
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
