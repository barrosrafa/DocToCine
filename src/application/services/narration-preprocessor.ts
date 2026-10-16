import { z } from 'zod';

export const PronunciationDictionarySchema = z.object({
  version: z.number().int().positive().default(1),
  language: z.string().default('pt-BR'),
  abbreviations: z.record(z.string(), z.string()).default({}),
  acronyms: z.record(z.string(), z.string()).default({}),
  properNouns: z.record(z.string(), z.string()).default({}),
});

export type PronunciationDictionary = z.infer<typeof PronunciationDictionarySchema>;

const DEFAULT_DICTIONARY: PronunciationDictionary = {
  version: 1,
  language: 'pt-BR',
  abbreviations: {
    'cap.': 'capítulo',
    'pág.': 'página',
    'págs.': 'páginas',
    'século XXI': 'século vinte e um',
    'século XX': 'século vinte',
    'século XIX': 'século dezenove',
    'Dr.': 'Doutor',
    'Dra.': 'Doutora',
    'Sr.': 'Senhor',
    'Sra.': 'Senhora',
  },
  acronyms: {
    IA: 'inteligência artificial',
    PDF: 'Pê Dê Éfe',
    TTS: 'síntese de voz',
  },
  properNouns: {},
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type PreprocessedNarration = {
  editorialText: string;
  spokenText: string;
};

export function preprocessNarrationText(
  text: string,
  dictionary: Partial<PronunciationDictionary> = {},
): PreprocessedNarration {
  const editorialText = text
    .replace(/\x00/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();

  const mergedDict: PronunciationDictionary = {
    version: dictionary.version ?? DEFAULT_DICTIONARY.version,
    language: dictionary.language ?? DEFAULT_DICTIONARY.language,
    abbreviations: { ...DEFAULT_DICTIONARY.abbreviations, ...(dictionary.abbreviations ?? {}) },
    acronyms: { ...DEFAULT_DICTIONARY.acronyms, ...(dictionary.acronyms ?? {}) },
    properNouns: { ...DEFAULT_DICTIONARY.properNouns, ...(dictionary.properNouns ?? {}) },
  };

  let spoken = editorialText
    // Remove markdown bullets/formatting symbols that shouldn't be spoken literally
    .replace(/^[-*•]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1');

  for (const [abbr, expansion] of Object.entries(mergedDict.abbreviations)) {
    const pattern = new RegExp(`(?<!\\w)${escapeRegExp(abbr)}(?!\\w)`, 'gi');
    spoken = spoken.replace(pattern, expansion);
  }

  for (const [acronym, phonetic] of Object.entries(mergedDict.acronyms)) {
    const pattern = new RegExp(`\\b${escapeRegExp(acronym)}\\b`, 'g');
    spoken = spoken.replace(pattern, phonetic);
  }

  for (const [noun, phonetic] of Object.entries(mergedDict.properNouns)) {
    const pattern = new RegExp(`\\b${escapeRegExp(noun)}\\b`, 'g');
    spoken = spoken.replace(pattern, phonetic);
  }

  spoken = spoken.replace(/[ \t]+/g, ' ').trim();
  return {
    editorialText,
    spokenText: spoken,
  };
}
