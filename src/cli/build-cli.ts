import { Command } from 'commander';
export function buildCli() {
  return new Command()
    .name('lcbooks')
    .description('Transforma PDFs em roteiros e vídeos')
    .argument('<pdf>', 'PDF de entrada')
    .option('-o, --output <dir>', 'diretório de saída', 'saida')
    .option('-c, --chapters <n>', 'número esperado de capítulos', '1')
    .option('-d, --durations <list>', 'durações: 1,3,20', '1,3,20')
    .option('--render-videos', 'renderizar MP4')
    .option('--resume', 'reutilizar artefatos válidos')
    .option('--force', 'forçar regeneração')
    .option('--continue-on-error', 'continuar após falhas')
    .option('--aspect-ratio <ratio>', '16:9 ou 9:16', '16:9')
    .option('-v, --verbose', 'logs detalhados');
}
