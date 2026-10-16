import {
  VideoScriptSchema,
  ensureScriptSegments,
  type VideoScript,
} from '../../domain/schemas/script.schema.js';
import type { ChapterBoundary, ChapterSummary } from '../../domain/schemas/chapter.schema.js';
import type { LlmProvider } from '../../domain/ports/llm-provider.js';
export class ScriptGenerator {
  constructor(readonly llm?: LlmProvider) {}
  async generate(
    summary: ChapterSummary,
    chapter: ChapterBoundary,
    duration: 1 | 3 | 20,
  ): Promise<VideoScript> {
    if (this.llm) {
      const s = await this.llm.generateStructured(
        `Gere um roteiro de ${duration} minuto(s) para ${chapter.title}: ${summary.thesis}`,
        VideoScriptSchema,
      );
      return ensureScriptSegments(s, summary.sourcePages);
    }
    const text = [summary.thesis, ...summary.keyPoints, summary.audienceTakeaway]
      .filter(Boolean)
      .join('\n\n');
    return ensureScriptSegments(
      VideoScriptSchema.parse({
        title: chapter.title,
        durationMinutes: duration,
        beats: ['Contexto', 'Ideia central', 'Conclusão'],
        narration: text || `Este capítulo apresenta ${chapter.title}.`,
        cta: 'Inscreva-se para continuar.',
        bRollAndVisuals: summary.visualMotifs,
      }),
      summary.sourcePages,
    );
  }
}
