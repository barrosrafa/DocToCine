# SDD — DocToCine v2.0

**Especificação de Design de Software e plano de implementação**  
**Projeto:** `barrosrafa/DocToCine`  
**Branch de referência auditada:** `main`  
**Data:** 16/10/2026  
**Stack existente:** Node.js 24, TypeScript ESM, Zod 4, OpenRouter via `fetch`, `pdfjs-dist`, Sharp, FFmpeg/FFprobe, Vitest, Pino.

> Este documento especifica a arquitetura e implementação da evolução v2.0 do DocToCine.

## 1. Resumo executivo

O DocToCine transforma PDFs em resumos, roteiros e vídeos narrados. A versão 2.0 evolui o projeto para um gerador audiovisual confiável, rastreável e de nível de produção:

1. **Fidelidade ao documento:** mapear capítulos e páginas, resumir capítulos longos por chunks com consolidação hierárquica e manter rastreabilidade das afirmações (`SupportedClaimSchema`).
2. **Roteiros mensuráveis:** produzir texto adequado à duração (`expectedWordRange`), avaliar cobertura dos pontos-chave (`ScriptQualityGate`), detectar invenções e validar o tempo com áudio real.
3. **Narração natural em pt-BR:** implementar o endpoint dedicado de TTS do OpenRouter (`/audio/speech` via `OpenRouterSpeechProvider`) além de manter compatibilidade multimodal, com pré-processamento fonético/editorial (`NarrationPreprocessor`), segmentação por sentenças (`TtsSegmenter`), validação de mídia via `ffprobe` (`AudioProbe`) e fallback para outro TTS real (`FallbackTtsProvider`).
4. **Legendas sincronizadas:** medir duração real, obter timestamps de palavras via forced alignment opcional (`WhisperXAligner`) ou alocação ponderada por sílabas/caracteres e pontuação (`ApproximateAligner`), e gerar cues de leitura em grupos de palavras (`SubtitleCueBuilder`) exportáveis para `.srt` e `.ass`.
5. **Mais mudanças visuais sem custo descontrolado:** planejar cortes de 6–10 segundos (`ScenePlanner`) sincronizados aos limites da fala, gerar assets principais via IA com cache SHA-256 canônico (`SceneCache`), limitar novas imagens por vídeo (`MAX_GENERATED_IMAGES_PER_VIDEO`) e criar variações com movimentos de câmera e composição (`ShotCompositor`).
6. **Render de nível de produção:** sincronizar timeline de cena, narração e legenda; normalizar loudness (`loudnorm`); respeitar dimensões/FPS/CRF/preset das configurações; fazer quality gate rigoroso do MP4 (`VideoQualityChecker`); retomar jobs interrompidos (`--resume`).
7. **Controle operacional:** fallback determinístico somente quando permitido, telemetria estruturada (`JobReporter`), guarda de orçamento (`CostGuard`), retries inteligentes com backoff e `Retry-After`, e relatórios acionáveis.
