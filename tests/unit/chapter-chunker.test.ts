import { describe, expect, it } from 'vitest';
import { chunkChapterPages } from '../../src/application/services/chapter-chunker.js';
import { detectChapters } from '../../src/application/services/chapter-detector.js';
import { extractPdfWithReport } from '../../src/infra/pdf/pdf-extractor.js';
import { createMinimalPdfBuffer } from '../helpers/fixture-generators.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('ChapterChunker & PDF Extraction Report (Fase 2 / Sprint B)', () => {
  it('divide capítulo longo em múltiplos chunks page-aware com overlap e marcadores [Página N]', () => {
    const pages = [
      {
        pageNumber: 10,
        text: 'Primeiro parágrafo extenso da página dez.\n\nSegundo parágrafo da página dez com mais detalhes sobre a arquitetura.',
        charCount: 118,
      },
      {
        pageNumber: 11,
        text: 'Conteúdo da página onze explicando os eventos intermediários.\n\nMais um parágrafo importante na página onze.',
        charCount: 108,
      },
      {
        pageNumber: 12,
        text: 'Desfecho do capítulo na página doze com conclusões e referências finais para o próximo ato.',
        charCount: 91,
      },
    ];

    const chunks = chunkChapterPages(pages, {
      chapterNumber: 2,
      maxChars: 220,
      overlapChars: 40,
      minPageChars: 10,
    });

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.chunkId).toBe('ch02_chunk_01');
    expect(chunks[0]?.text).toContain('[Página 10]');
    const allSourcePages = new Set(chunks.flatMap((c) => c.sourcePages));
    expect([...allSourcePages].sort((a, b) => a - b)).toEqual([10, 11, 12]);
    for (const c of chunks) {
      expect(c.sourcePages.every((p) => p >= 10 && p <= 12)).toBe(true);
      expect(c.endChar).toBeGreaterThan(c.startChar);
    }
  });

  it('divide uma página única muito grande por parágrafos/sentenças sem perder conteúdo', () => {
    const hugeParagraph1 = 'Sentença um sobre o arquivo histórico. '.repeat(25).trim();
    const hugeParagraph2 = 'Sentença dois sobre a expedição marítima. '.repeat(25).trim();
    const pages = [
      {
        pageNumber: 5,
        text: `${hugeParagraph1}\n\n${hugeParagraph2}`,
        charCount: hugeParagraph1.length + hugeParagraph2.length + 2,
      },
    ];

    const chunks = chunkChapterPages(pages, {
      chapterNumber: 1,
      maxChars: 1200,
      overlapChars: 100,
      minPageChars: 10,
    });

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((c) => c.sourcePages.includes(5))).toBe(true);
    expect(chunks[0]?.text).toContain('[Página 5]');
  });

  it('detectChapters retorna score, evidências e ignora sumário e menções no meio do texto', () => {
    const pages = [
      {
        pageNumber: 1,
        text: 'Sumário\nCapítulo 1 ........ 2\nCapítulo 2 ........ 4\nCapítulo 3 ........ 6',
        charCount: 75,
      },
      {
        pageNumber: 2,
        text: 'Capítulo 1: O Despertar\nNo início da jornada, tudo parecia calmo na vila.',
        charCount: 74,
      },
      {
        pageNumber: 3,
        text: 'O narrador lembra que neste capítulo da vida nada é simples, pois cada capítulo traz lições e outro capítulo começa.',
        charCount: 116,
      },
      {
        pageNumber: 4,
        text: 'Capítulo 2: A Travessia\nO navio partiu antes do amanhecer rumo ao sul.',
        charCount: 71,
      },
    ];

    const result = detectChapters(pages, 2);
    expect(result.detectedPages).toEqual([2, 4]);
    expect(result.boundaries).toHaveLength(2);
    expect(result.boundaries[0]?.startPage).toBe(2);
    expect(result.boundaries[0]?.endPage).toBe(3);
    expect(result.boundaries[1]?.startPage).toBe(4);
    expect(result.boundaries[1]?.endPage).toBe(4);
    expect(result.score).toBeGreaterThan(0.5);
  });

  it('extrai PDF real com relatório de qualidade (extractPdfWithReport)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doctocine-pdf-'));
    try {
      const pdfPath = join(dir, 'test.pdf');
      const buf = createMinimalPdfBuffer([
        'Capitulo 1: Introducao\nTexto completo da primeira pagina com informacoes suficientes para boa qualidade.',
        'Capitulo 2: Conclusao\nTexto da segunda pagina encerrando o documento de teste com clareza.',
      ]);
      await writeFile(pdfPath, buf);

      const { pages, report } = await extractPdfWithReport(pdfPath, {
        maxBytes: 5 * 1024 * 1024,
        maxPages: 50,
      });

      expect(pages).toHaveLength(2);
      expect(report.pageCount).toBe(2);
      expect(report.totalChars).toBeGreaterThan(50);
      expect(report.emptyPages).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
