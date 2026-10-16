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
      try {
        const config = {
          1: { minWords: 120, maxWords: 150, paragraphs: 3, beats: 3 },
          3: { minWords: 380, maxWords: 450, paragraphs: 6, beats: 5 },
          20: { minWords: 2000, maxWords: 2500, paragraphs: 15, beats: 8 },
        }[duration];

        const prompt = `Você é um roteirista profissional de cinema e audiolivros. Crie um roteiro cinematográfico para vídeo de EXATAMENTE ${duration} minuto(s) sobre ${chapter.title}.

Tese/Resumo do capítulo:
${summary.thesis}

Pontos principais:
${summary.keyPoints.join('\n- ')}

Requisitos estritos:
1. durationMinutes: DEVE ser exatamente o número ${duration}.
2. narration: Texto falado completo em português fluente com aproximadamente ${config.minWords} a ${config.maxWords} palavras no total.
3. Divida a narração em exatamente ${config.paragraphs} parágrafos bem desenvolvidos, separados por duas quebras de linha (\\n\\n). Cada parágrafo será uma cena do vídeo.
4. beats: Array com ${config.beats} títulos curtos descrevendo as batidas emocionais da narrativa.
5. bRollAndVisuals: Array com ${config.paragraphs} descrições visuais cinematográficas detalhadas para compor as cenas.
6. hook: Uma frase inicial impactante e instigante.
7. cta: Uma chamada final convincente para a audiência.

Retorne APENAS um JSON válido respeitando o schema com todos os campos preenchidos.`;

        const s = await this.llm.generateStructured(prompt, VideoScriptSchema);
        return ensureScriptSegments(s, summary.sourcePages);
      } catch {
        // Fall back to deterministic generation
      }
    }

    return this.generateDeterministic(summary, chapter, duration);
  }

  private generateDeterministic(
    summary: ChapterSummary,
    chapter: ChapterBoundary,
    duration: 1 | 3 | 20,
  ): VideoScript {
    const numScenes = duration === 1 ? 3 : duration === 3 ? 6 : 15;
    const paragraphs: string[] = [];
    const beats: string[] = [];
    const visuals: string[] = [];

    // Scene 1: Hook and context
    const cleanThesis = summary.thesis.replace(/\s+/g, ' ').trim().slice(0, 300);
    paragraphs.push(
      `Bem-vindo à análise cinematográfica de ${chapter.title}. Este capítulo estabelece o tom da narrativa ao apresentar os dilemas e acontecimentos fundamentais: ${cleanThesis || `uma imersão profunda nos mistérios de ${chapter.title}.`}`,
    );
    beats.push('Contexto e Ponto de Partida');
    visuals.push(`Cena de abertura imersiva e atmosférica de ${chapter.title}`);

    // Middle scenes: Key points and escalation
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
        `À medida que o capítulo avança, nos deparamos com um elemento determinante: ${pt}. Essa sequência aprofunda as contradições e conduz a história em direção a um momento inevitável de confrontação.`,
      );
      beats.push(`Desenvolvimento ${i}: ${pt.slice(0, 35)}`);
      visuals.push(`Plano expressivo focado em: ${pt.slice(0, 60)}`);
    }

    // Final scene: Climax and takeaway
    const takeaway =
      summary.audienceTakeaway || 'uma reflexão duradoura sobre os limites e revelações da obra.';
    paragraphs.push(
      `Por fim, ${chapter.title} culmina em um desfecho significativo que redefine nossa compreensão dos eventos: ${takeaway}`,
    );
    beats.push('Conclusão e Impacto Narrativo');
    visuals.push(`Plano de encerramento cinematográfico de ${chapter.title}`);

    const script = VideoScriptSchema.parse({
      title: chapter.title,
      durationMinutes: duration,
      hook: `O que os segredos de ${chapter.title} revelam sobre o destino de seus personagens?`,
      beats,
      narration: paragraphs.join('\n\n'),
      cta: 'Inscreva-se para acompanhar a análise detalhada dos próximos capítulos.',
      bRollAndVisuals: visuals,
    });

    return ensureScriptSegments(script, summary.sourcePages);
  }
}
