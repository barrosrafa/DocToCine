import type { ChapterSummary } from '../../domain/schemas/chapter.schema.js';
import type { VideoScript } from '../../domain/schemas/script.schema.js';

export type WordRange = {
  min: number;
  max: number;
  target: number;
};

export type ScriptQualityEvaluation = {
  passed: boolean;
  wordCount: number;
  expectedRange: { min: number; max: number };
  withinWordRange: boolean;
  keyPointCoverageRatio: number;
  issues: string[];
  warnings: string[];
};

const AI_META_PATTERN =
  /\b(como\s+(uma?\s+)?ia|como\s+modelo\s+de\s+linguagem|como\s+assistente\s+virtual|aqui\s+est[aá]\s+o\s+roteiro|espero\s+que\s+ajude)\b/i;

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function expectedWordRange(
  durationMinutes: number,
  targetWpm = 135,
  tolerancePercent = 8,
): { min: number; max: number } {
  const target = durationMinutes * targetWpm;
  const delta = target * (tolerancePercent / 100);
  return {
    min: Math.floor(target - delta),
    max: Math.ceil(target + delta),
  };
}

function normalizeToken(token: string): string {
  return token
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function significantTokens(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length >= 4);
}

export function evaluateScriptQuality(
  script: VideoScript,
  summary: ChapterSummary,
  options: { targetWpm?: number; tolerancePercent?: number } = {},
): ScriptQualityEvaluation {
  const targetWpm = options.targetWpm ?? 135;
  const tolerancePercent = options.tolerancePercent ?? 8;
  const expectedRange = expectedWordRange(script.durationMinutes, targetWpm, tolerancePercent);
  const wordCount = countWords(script.narration);
  const withinWordRange = wordCount >= expectedRange.min && wordCount <= expectedRange.max;

  const issues: string[] = [];
  const warnings: string[] = [];

  if (!withinWordRange) {
    warnings.push(
      `Contagem de palavras (${wordCount}) fora da meta recomendada (${expectedRange.min}–${expectedRange.max} para ${script.durationMinutes} min).`,
    );
  }

  if (AI_META_PATTERN.test(script.narration) || AI_META_PATTERN.test(script.hook)) {
    issues.push('Roteiro contém meta-linguagem de IA ou instruções de prompt.');
  }

  const paragraphs = script.narration
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const seenParagraphs = new Set<string>();
  for (const p of paragraphs) {
    const norm = p.toLowerCase().replace(/\s+/g, ' ');
    if (seenParagraphs.has(norm)) {
      issues.push(`Parágrafo duplicado detectado na narração: "${p.slice(0, 50)}..."`);
      break;
    }
    seenParagraphs.add(norm);
  }

  // Cobertura de keyPoints
  const narrationTokens = new Set(significantTokens(script.narration));
  let coveredKeyPoints = 0;
  for (const kp of summary.keyPoints) {
    const kpTokens = significantTokens(kp);
    if (kpTokens.length === 0) {
      coveredKeyPoints++;
      continue;
    }
    const matched = kpTokens.filter((t) => narrationTokens.has(t)).length;
    if (matched >= 1 || matched / kpTokens.length >= 0.25) {
      coveredKeyPoints++;
    }
  }

  const keyPointCoverageRatio =
    summary.keyPoints.length > 0 ? coveredKeyPoints / summary.keyPoints.length : 1;

  if (summary.keyPoints.length > 0 && keyPointCoverageRatio < 0.5) {
    warnings.push(`Cobertura de pontos-chave baixa (${Math.round(keyPointCoverageRatio * 100)}%).`);
  }

  return {
    passed: issues.length === 0,
    wordCount,
    expectedRange,
    withinWordRange,
    keyPointCoverageRatio,
    issues,
    warnings,
  };
}
