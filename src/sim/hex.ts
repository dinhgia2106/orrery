/** Parse an Intel HEX file (as produced by avr-gcc / arduino-cli) into AVR program memory. */
export function parseIntelHex(text: string, flashBytes = 0x8000): Uint16Array {
  const bytes = new Uint8Array(flashBytes);
  let base = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] !== ':') throw new Error(`invalid HEX line: ${line}`);
    const count = parseInt(line.slice(1, 3), 16);
    const addr = parseInt(line.slice(3, 7), 16);
    const type = parseInt(line.slice(7, 9), 16);
    const data = line.slice(9, 9 + count * 2);
    if (type === 0x00) {
      for (let i = 0; i < count; i++) {
        const at = base + addr + i;
        if (at >= flashBytes) throw new Error(`HEX data at 0x${at.toString(16)} exceeds flash size`);
        bytes[at] = parseInt(data.slice(i * 2, i * 2 + 2), 16);
      }
    } else if (type === 0x01) {
      break;
    } else if (type === 0x02) {
      base = parseInt(data, 16) * 16;
    } else if (type === 0x04) {
      base = parseInt(data, 16) << 16;
    }
  }
  return new Uint16Array(bytes.buffer);
}

/** Encode program words as Intel HEX (used to ship tiny hand-assembled demos). */
export function toIntelHex(words: number[]): string {
  const bytes = words.flatMap((w) => [w & 0xff, w >> 8]);
  const lines: string[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.slice(off, off + 16);
    const rec = [chunk.length, (off >> 8) & 0xff, off & 0xff, 0x00, ...chunk];
    const sum = (0x100 - (rec.reduce((a, b) => a + b, 0) & 0xff)) & 0xff;
    lines.push(':' + [...rec, sum].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(''));
  }
  lines.push(':00000001FF');
  return lines.join('\n') + '\n';
}
