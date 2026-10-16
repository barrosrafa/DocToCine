import { Command } from 'commander';

export function buildCli() {
  return new Command()
    .name('lcbooks')
    .description('Transforma PDFs em resumos, roteiros cinematográficos e vídeos narrados (v2.0)')
    .argument('<pdf>', 'PDF de entrada')
    .option('-o, --output <dir>', 'diretório de saída', 'saida')
    .option('-c, --chapters <n>', 'número esperado de capítulos', '1')
    .option('-d, --durations <list>', 'durações: 1,3,20', '1,3,20')
    .option('--render-videos', 'renderizar MP4')
    .option('--resume', 'reutilizar artefatos válidos de etapas concluídas')
    .option('--force', 'forçar regeneração completa')
    .option('--continue-on-error', 'continuar processamento em caso de falhas parciais')
    .option('--aspect-ratio <ratio>', 'proporção do vídeo: 16:9 ou 9:16', '16:9')
    .option('--visual-mode <mode>', 'densidade visual: economic, balanced, dynamic', 'balanced')
    .option('--voice <voice-id>', 'identificador de voz para síntese TTS')
    .option(
      '--no-burn-captions',
      'não queimar legendas no vídeo (mantém apenas arquivo lateral SRT/ASS)',
    )
    .option('--max-cost-usd <value>', 'limite de orçamento em dólares por execução')
    .option('-v, --verbose', 'logs estruturados detalhados');
}
