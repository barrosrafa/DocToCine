import { AppError } from '../../core/errors/app-error.js';

export type TextChunk = {
  chunkId: string;
  chapterNumber: number;
  index: number;
  text: string;
  sourcePages: number[];
  startChar: number;
  endChar: number;
};

export type ChunkChapterOptions = {
  chapterNumber?: number;
  maxChars: number;
  overlapChars: number;
  minPageChars?: number;
};

type PageBlock = {
  pageNumber: number;
  content: string;
};

function splitLargePageText(pageNumber: number, text: string, maxBlockChars: number): PageBlock[] {
  const header = `[Página ${pageNumber}]\n`;
  const effectiveMax = Math.max(120, maxBlockChars - header.length);
  if (text.length <= effectiveMax) {
    return [{ pageNumber, content: `${header}${text}` }];
  }

  const blocks: PageBlock[] = [];
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  let current = '';
  const flush = () => {
    if (current.trim().length > 0) {
      blocks.push({ pageNumber, content: `${header}${current.trim()}` });
      current = '';
    }
  };

  for (const para of paragraphs) {
    if (para.length > effectiveMax) {
      flush();
      const sentences = para.split(/(?<=[.!?…])\s+/);
      for (const sentence of sentences) {
        if (sentence.length > effectiveMax) {
          flush();
          for (let offset = 0; offset < sentence.length; offset += effectiveMax) {
            blocks.push({
              pageNumber,
              content: `${header}${sentence.slice(offset, offset + effectiveMax).trim()}`,
            });
          }
          continue;
        }
        if ((current ? `${current} ${sentence}` : sentence).length > effectiveMax) {
          flush();
          current = sentence;
        } else {
          current = current ? `${current} ${sentence}` : sentence;
        }
      }
    } else if ((current ? `${current}\n\n${para}` : para).length > effectiveMax) {
      flush();
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  flush();
  return blocks.length > 0 ? blocks : [{ pageNumber, content: `${header}${text}` }];
}

export function chunkChapterPages(
  pages: { pageNumber: number; text: string; charCount?: number }[],
  options: ChunkChapterOptions,
): TextChunk[] {
  const { maxChars, overlapChars, chapterNumber = 1, minPageChars = 1 } = options;
  if (maxChars < 200 || maxChars > 60000) {
    throw new AppError(`maxChars inválido para chunker: ${maxChars}`, {
      code: 'INVALID_INPUT',
      stage: 'summary',
    });
  }
  if (overlapChars < 0 || overlapChars >= maxChars) {
    throw new AppError(`overlapChars inválido: ${overlapChars}`, {
      code: 'INVALID_INPUT',
      stage: 'summary',
    });
  }

  const nonEmptyPages = pages.filter((p) => p.text.trim().length >= minPageChars);
  const targetPages = nonEmptyPages.length > 0 ? nonEmptyPages : pages;
  if (targetPages.length === 0) return [];

  const blocks: PageBlock[] = [];
  for (const page of targetPages) {
    const clean = page.text.trim();
    if (!clean) continue;
    blocks.push(...splitLargePageText(page.pageNumber, clean, maxChars));
  }

  if (blocks.length === 0) {
    const firstPage = targetPages[0]!;
    return [
      {
        chunkId: `ch${String(chapterNumber).padStart(2, '0')}_chunk_01`,
        chapterNumber,
        index: 0,
        text: `[Página ${firstPage.pageNumber}]\n${firstPage.text.trim()}`,
        sourcePages: [firstPage.pageNumber],
        startChar: 0,
        endChar: Math.max(1, firstPage.text.length),
      },
    ];
  }

  const chunks: TextChunk[] = [];
  let curBlocks: PageBlock[] = [];
  let charCursor = 0;

  const emitChunk = (chunkBlocks: PageBlock[], overlapPrefix = '', overlapPage?: number) => {
    const body = chunkBlocks.map((b) => b.content).join('\n\n');
    const fullText = overlapPrefix ? `${overlapPrefix}\n\n${body}` : body;
    const pageSet = new Set<number>();
    if (overlapPage !== undefined) pageSet.add(overlapPage);
    for (const b of chunkBlocks) pageSet.add(b.pageNumber);

    const startChar = Math.max(0, charCursor - overlapPrefix.length);
    const endChar = startChar + fullText.length;
    charCursor = endChar;

    const index = chunks.length;
    chunks.push({
      chunkId: `ch${String(chapterNumber).padStart(2, '0')}_chunk_${String(index + 1).padStart(2, '0')}`,
      chapterNumber,
      index,
      text: fullText,
      sourcePages: [...pageSet].sort((a, b) => a - b),
      startChar,
      endChar,
    });
  };

  let prevTail = '';
  let prevTailPage: number | undefined;

  for (const block of blocks) {
    const candidateText = [...curBlocks, block].map((b) => b.content).join('\n\n');
    const totalLen = (prevTail ? `${prevTail}\n\n${candidateText}` : candidateText).length;

    if (curBlocks.length > 0 && totalLen > maxChars) {
      emitChunk(curBlocks, prevTail, prevTailPage);
      const lastBlock = curBlocks.at(-1)!;
      if (overlapChars > 0) {
        const tailSlice = lastBlock.content.slice(-overlapChars).trim();
        prevTail = tailSlice.startsWith('[Página')
          ? tailSlice
          : `[Página ${lastBlock.pageNumber}]\n${tailSlice}`;
        prevTailPage = lastBlock.pageNumber;
      } else {
        prevTail = '';
        prevTailPage = undefined;
      }
      curBlocks = [block];
    } else {
      curBlocks.push(block);
    }
  }

  if (curBlocks.length > 0) {
    emitChunk(curBlocks, prevTail, prevTailPage);
  }

  return chunks;
}
