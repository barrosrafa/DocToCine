export function createValidWavBuffer(durationSeconds = 1.5, sampleRate = 16000): Buffer {
  const totalSamples = Math.max(1, Math.round(durationSeconds * sampleRate));
  const dataSize = totalSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // Mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.floor(Math.sin(2 * Math.PI * 330 * t) * 4000);
    buffer.writeInt16LE(sample, 44 + i * 2);
  }
  return buffer;
}

export function createMinimalPdfBuffer(pagesText: string[]): Buffer {
  const objects: string[] = [];
  const addObj = (body: string) => {
    objects.push(body);
    return objects.length;
  };

  const fontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];

  for (const rawText of pagesText) {
    const escaped = rawText
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/\r?\n/g, ') Tj T* (');
    const stream = `BT /F1 12 Tf 14 TL 50 750 Td (${escaped}) Tj ET`;
    const contentId = addObj(
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    );
    const pageId = addObj(
      `<< /Type /Page /Parent PAGES_REF 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  const kids = pageIds.map((id) => `${id} 0 R`).join(' ');
  const pagesId = addObj(`<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length} >>`);
  const catalogId = addObj(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  const finalObjects = objects.map((o) => o.replace(/PAGES_REF/g, String(pagesId)));

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (let i = 0; i < finalObjects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${finalObjects[i]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${finalObjects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${finalObjects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}
