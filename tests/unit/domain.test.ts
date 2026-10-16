import { describe, expect, it } from 'vitest';
import { VideoScriptSchema, ensureScriptSegments } from '../../src/domain/schemas/script.schema.js';
import { normalizeChapterSummary } from '../../src/domain/schemas/chapter.schema.js';
import { sanitizeMessage } from '../../src/core/logging/redact.js';
import { canTransition } from '../../src/domain/schemas/video.schema.js';
describe('contratos de domínio', () => {
  it('valida durações e cria segmentos legados', () => {
    expect(() =>
      VideoScriptSchema.parse({ durationMinutes: 5, beats: ['x'], narration: 'x' }),
    ).toThrow();
    const s = VideoScriptSchema.parse({
      durationMinutes: 1,
      beats: ['A', 'B'],
      narration: 'Primeiro.\n\nSegundo.',
    });
    expect(ensureScriptSegments(s, [2]).segments.map((x) => x.id)).toEqual([
      'seg_0001',
      'seg_0002',
    ]);
  });
  it('normaliza claims legados e retém páginas', () => {
    const s = normalizeChapterSummary({
      keyPoints: [{ claim: 'Ideia', sourcePages: [4], confidence: 'high' }],
    });
    expect(s.keyPoints).toEqual(['Ideia']);
    expect(s.sourcePages).toEqual([4]);
  });
  it('redige segredos e controla transições', () => {
    expect(sanitizeMessage('AIzaSySecretKey1234567890 token secreto', ['secreto'])).not.toContain(
      'secreto',
    );
    expect(canTransition('pending', 'script_ready')).toBe(true);
    expect(canTransition('completed', 'rendering')).toBe(false);
  });
});
