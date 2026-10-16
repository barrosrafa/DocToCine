# DocToCine / lcBooks TypeScript

Migração incremental do pipeline **lcBooks** de Python para TypeScript, conforme o SDD. O pacote mantém a CLI `lcbooks` e separa domínio, aplicação e infraestrutura.

## Uso

```bash
cd typescript
npm ci
npm run check
npm run build
node dist/main.js livro.pdf --output saida --chapters 3 --durations 1,3,20 --render-videos
```

A implementação usa schemas Zod em runtime, escrita atômica de artefatos, paths relativos nos manifestos, sanitização de logs, geração de cenas local com Sharp, TTS fake determinístico e FFmpeg com `shell: false`. Providers externos devem ser conectados atrás das interfaces em `src/domain/ports`.

> O modo `TTS_PROVIDER=fake` é o padrão para testes sem custo de API. Para produção, configure os adapters Gemini e Google Cloud TTS com ADC/credenciais fora do repositório.
