import {
  VideoScriptSchema,
  ensureScriptSegments,
  type ScriptTone,
  type VideoScript,
} from '../../domain/schemas/script.schema.js';
import type { ChapterBoundary, ChapterSummary } from '../../domain/schemas/chapter.schema.js';
import type { LlmProvider } from '../../domain/ports/llm-provider.js';
import { AppError } from '../../core/errors/app-error.js';
import { countWords, evaluateScriptQuality, expectedWordRange } from './script-quality-gate.js';

export type ScriptGenerationOptions = {
  targetWpm?: number;
  tolerancePercent?: number;
  allowDeterministicFallback?: boolean;
  tone?: ScriptTone;
  targetAudience?: string;
};

export type ScriptGenerationOutcome = {
  script: VideoScript;
  degraded: boolean;
  revisionApplied: boolean;
  usedModel?: string;
  warnings: string[];
};

const PROMPT_VERSION = 'v2.0';

export class ScriptGenerator {
  private readonly targetWpm: number;
  private readonly tolerancePercent: number;
  private readonly allowDeterministicFallback: boolean;
  private readonly tone: ScriptTone;
  private readonly targetAudience: string;

  constructor(
    readonly llm?: LlmProvider,
    options: ScriptGenerationOptions = {},
  ) {
    this.targetWpm = options.targetWpm ?? 135;
    this.tolerancePercent = options.tolerancePercent ?? 8;
    this.allowDeterministicFallback = options.allowDeterministicFallback ?? true;
    this.tone = options.tone ?? 'cinematografico';
    this.targetAudience = options.targetAudience ?? 'Público geral e leitores';
  }

  get promptVersion(): string {
    return PROMPT_VERSION;
  }

  private async invokeScriptLlm(
    prompt: string,
  ): Promise<{ script: VideoScript; usedModel?: string; degraded: boolean }> {
    if (!this.llm) {
      throw new Error('LLM provider ausente');
    }
    if (this.llm.generateStructuredWithMeta) {
      const meta = await this.llm.generateStructuredWithMeta(prompt, VideoScriptSchema, {
        task: 'script',
      });
      return {
        script: meta.data,
        usedModel: meta.usedModel,
        degraded: meta.degraded,
      };
    }
    const data = await this.llm.generateStructured(prompt, VideoScriptSchema, {
      task: 'script',
    });
    return { script: data, degraded: false };
  }

  async generateWithMeta(
    summary: ChapterSummary,
    chapter: ChapterBoundary,
    duration: 1 | 3 | 20,
  ): Promise<ScriptGenerationOutcome> {
    const range = expectedWordRange(duration, this.targetWpm, this.tolerancePercent);
    const structure = {
      1: { paragraphs: 3, beats: 3 },
      3: { paragraphs: 6, beats: 5 },
      20: { paragraphs: 15, beats: 8 },
    }[duration];

    if (this.llm) {
      try {
        const claimsText = summary.supportedClaims
          .slice(0, 12)
          .map((c) => `- [${c.claimId}] (Págs. ${c.sourcePages.join(', ')}): ${c.claim}`)
          .join('\n');

        const prompt = `Você é um roteirista profissional de cinema e audiolivros em português do Brasil (pt-BR).
Crie um roteiro ${this.tone} para um vídeo de ${duration} minuto(s) sobre "${chapter.title}" voltado para "${this.targetAudience}".

Tese/Resumo consolidado do capítulo:
${summary.thesis}

Pontos principais obrigatórios:
${summary.keyPoints.map((kp) => `- ${kp}`).join('\n')}

Evidências verificadas e páginas-fonte:
${claimsText || '- Baseado nas páginas ' + summary.sourcePages.join(', ')}

Requisitos estritos:
1. durationMinutes: DEVE ser exatamente o número ${duration}.
2. narration: Texto falado completo em português brasileiro natural, contendo entre ${range.min} e ${range.max} palavras (meta de ${this.targetWpm} palavras por minuto).
3. Divida a narração em ${structure.paragraphs} parágrafos bem desenvolvidos, separados por duas quebras de linha (\\n\\n).
4. Não invente fatos, personagens ou eventos ausentes no resumo/evidências. Não escreva frases como "como IA" ou comentários fora da narração.
5. beats: Array com ${structure.beats} títulos curtos descrevendo as batidas narrativas.
6. bRollAndVisuals: Array com ${structure.paragraphs} descrições visuais cinematográficas concretas e sem textos na imagem.
7. hook: Uma frase inicial impactante e fiel ao tema.
8. cta: Uma chamada final elegante e concisa.

Retorne APENAS um JSON válido respeitando o schema.`;

        let { script, usedModel, degraded } = await this.invokeScriptLlm(prompt);
        let revisionApplied = false;
        const warnings: string[] = [];

        const initialWords = countWords(script.narration);
        const initialEval = evaluateScriptQuality(script, summary, {
          targetWpm: this.targetWpm,
          tolerancePercent: this.tolerancePercent,
        });

        // No máximo uma revisão de expansão/condensação ou correção de qualidade
        if (!initialEval.withinWordRange || !initialEval.passed) {
          const direction =
            initialWords < range.min
              ? `expanda a narração adicionando detalhes factuais do resumo até atingir entre ${range.min} e ${range.max} palavras`
              : initialWords > range.max
                ? `condense a narração removendo redundâncias até ficar entre ${range.min} e ${range.max} palavras`
                : 'corrija os problemas apontados';

          const revisionPrompt = `${prompt}\n\nREVISÃO DE VOLUME E QUALIDADE:
O rascunho anterior teve ${initialWords} palavras (meta: ${range.min}–${range.max} palavras).
${initialEval.issues.length > 0 ? `Problemas detectados: ${initialEval.issues.join('; ')}` : ''}
Por favor, ${direction}, preservando todos os fatos, claims e páginas-fonte. Retorne o JSON completo atualizado.`;

          try {
            const revised = await this.invokeScriptLlm(revisionPrompt);
            script = revised.script;
            if (revised.usedModel) usedModel = revised.usedModel;
            degraded = degraded || revised.degraded;
            revisionApplied = true;
          } catch (revErr: unknown) {
            if (revErr instanceof AppError && !revErr.retryable) {
              throw revErr;
            }
            warnings.push(
              `Revisão de ajuste de palavras não pôde ser aplicada: ${revErr instanceof Error ? revErr.message : String(revErr)}`,
            );
          }
        }

        const finalEval = evaluateScriptQuality(script, summary, {
          targetWpm: this.targetWpm,
          tolerancePercent: this.tolerancePercent,
        });
        warnings.push(...finalEval.warnings, ...finalEval.issues);

        const normalized = ensureScriptSegments(
          {
            ...script,
            schemaVersion: 2,
            title: script.title || chapter.title,
            language: 'pt-BR',
            tone: script.tone ?? this.tone,
            targetAudience: script.targetAudience || this.targetAudience,
            degraded,
            ...(usedModel !== undefined ? { usedModel } : {}),
            warnings,
          },
          summary.sourcePages,
          summary.supportedClaims,
        );

        return {
          script: normalized,
          degraded,
          revisionApplied,
          ...(usedModel !== undefined ? { usedModel } : {}),
          warnings,
        };
      } catch (err: unknown) {
        if (err instanceof AppError && !err.retryable) {
          throw err;
        }
        if (!this.allowDeterministicFallback) {
          throw err;
        }
        const warnMsg = `Fallback determinístico acionado para roteiro (${duration}min) após falha na IA: ${err instanceof Error ? err.message : String(err)}`;
        const fallbackScript = this.generateDeterministic(summary, chapter, duration, [warnMsg]);
        return {
          script: fallbackScript,
          degraded: true,
          revisionApplied: false,
          warnings: [warnMsg],
        };
      }
    }

    if (!this.allowDeterministicFallback) {
      throw new AppError('LLM provider não configurado e fallback determinístico desabilitado.', {
        code: 'LLM_INVALID_OUTPUT',
        stage: 'script_generation',
        retryable: false,
      });
    }

    const offlineWarn = 'Roteiro gerado em modo determinístico local (sem provedor LLM ativo).';
    const deterministic = this.generateDeterministic(summary, chapter, duration, [offlineWarn]);
    return {
      script: deterministic,
      degraded: true,
      revisionApplied: false,
      warnings: [offlineWarn],
    };
  }

  async generate(
    summary: ChapterSummary,
    chapter: ChapterBoundary,
    duration: 1 | 3 | 20,
  ): Promise<VideoScript> {
    const outcome = await this.generateWithMeta(summary, chapter, duration);
    return outcome.script;
  }

  private generateDeterministic(
    summary: ChapterSummary,
    chapter: ChapterBoundary,
    duration: 1 | 3 | 20,
    warnings: string[] = [],
  ): VideoScript {
    const numScenes = duration === 1 ? 3 : duration === 3 ? 6 : 15;
    const paragraphs: string[] = [];
    const beats: string[] = [];
    const visuals: string[] = [];

    const cleanThesis = summary.thesis.replace(/\s+/g, ' ').trim().slice(0, 300);
    paragraphs.push(
      `Bem-vindo à análise cinematográfica de ${chapter.title}. Este capítulo estabelece o tom da narrativa ao apresentar os dilemas e acontecimentos fundamentais: ${cleanThesis || `uma imersão profunda nos mistérios de ${chapter.title}.`}`,
    );
    beats.push('Contexto e Ponto de Partida');
    visuals.push(`Cena de abertura imersiva e atmosférica de ${chapter.title}`);

    const points = summary.keyPoints.length
      ? summary.keyPoints
      : [
          `Os primeiros indícios e conflitos que marcam ${chapter.title}`,
          'A revelação de camadas e tensões ocultas entre os personagens',
          'Um ponto de virada decisivo que altera o rumo dos acontecimentos',
        ];

    for (let i = 1; i < numScenes - 1; i++) {
      const pt = points[(i - 1) % points.length] ?? `Desenvolvimento central de ${chapter.title}`;
      paragraphs.push(
        `Na etapa ${i} do capítulo, acompanhamos um elemento determinante: ${pt}. Essa sequência aprofunda as evidências das páginas analisadas e conduz a narrativa até o momento decisivo.`,
      );
      beats.push(`Desenvolvimento ${i}: ${pt.slice(0, 35)}`);
      visuals.push(`Plano expressivo focado em: ${pt.slice(0, 60)}`);
    }

    const takeaway =
      summary.audienceTakeaway || 'uma reflexão duradoura sobre os limites e revelações da obra.';
    paragraphs.push(
      `Por fim, ${chapter.title} culmina em um desfecho significativo que redefine nossa compreensão dos eventos: ${takeaway}`,
    );
    beats.push('Conclusão e Impacto Narrativo');
    visuals.push(`Plano de encerramento cinematográfico de ${chapter.title}`);

    const script = VideoScriptSchema.parse({
      schemaVersion: 2,
      title: chapter.title,
      durationMinutes: duration,
      language: 'pt-BR',
      tone: this.tone,
      targetAudience: this.targetAudience,
      hook: `O que os acontecimentos de ${chapter.title} revelam sobre o rumo da obra?`,
      beats,
      narration: paragraphs.join('\n\n'),
      cta: 'Inscreva-se para acompanhar a análise detalhada dos próximos capítulos.',
      bRollAndVisuals: visuals,
      sourcePages: summary.sourcePages,
      claims: summary.supportedClaims,
      degraded: true,
      warnings,
    });

    return ensureScriptSegments(script, summary.sourcePages, summary.supportedClaims);
  }
}
