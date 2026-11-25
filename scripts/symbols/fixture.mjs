const align = (n, to) => Math.ceil(n / to) * to;

function uleb(value) {
  const out = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
}

export function machO({ uuid, base = 0x100000000, textAddr = base + 0x1000, text, symbols = [], starts = [], cpu = 0x0100000c, extraSections = [] }) {
  const sections = [["__text", "__TEXT", textAddr, text.length], ...extraSections.map((s) => [s.name, s.segment, s.addr, s.size])];
  const segmentSize = 72 + 80 * sections.length;
  const commandsSize = segmentSize + 24 + 24 + 16;
  const textOffset = align(32 + commandsSize, 16);
  const startsBytes = [];
  let previous = base;
  for (const s of starts) {
    startsBytes.push(...uleb(s - previous));
    previous = s;
  }
  startsBytes.push(0);
  const startsOffset = align(textOffset + text.length, 8);
  const strings = [0];
  const strx = symbols.map((s) => {
    const at = strings.length;
    strings.push(...Buffer.from(s.name, "utf8"), 0);
    return at;
  });
  const symOffset = align(startsOffset + startsBytes.length, 8);
  const strOffset = symOffset + symbols.length * 16;
  const buffer = Buffer.alloc(strOffset + strings.length);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeInt32LE(cpu, 4);
  buffer.writeUInt32LE(6, 12);
  buffer.writeUInt32LE(4, 16);
  buffer.writeUInt32LE(commandsSize, 20);
  let at = 32;
  buffer.writeUInt32LE(0x19, at);
  buffer.writeUInt32LE(segmentSize, at + 4);
  buffer.write("__TEXT", at + 8);
  buffer.writeBigUInt64LE(BigInt(base), at + 24);
  buffer.writeBigUInt64LE(BigInt(textAddr - base + text.length), at + 32);
  buffer.writeUInt32LE(sections.length, at + 64);
  sections.forEach(([name, segment, addr, size], i) => {
    const s = at + 72 + i * 80;
    buffer.write(name, s);
    buffer.write(segment, s + 16);
    buffer.writeBigUInt64LE(BigInt(addr), s + 32);
    buffer.writeBigUInt64LE(BigInt(size), s + 40);
    buffer.writeUInt32LE(i === 0 ? textOffset : 0, s + 48);
  });
  at += segmentSize;
  buffer.writeUInt32LE(0x1b, at);
  buffer.writeUInt32LE(24, at + 4);
  Buffer.from(uuid.replace(/-/g, ""), "hex").copy(buffer, at + 8);
  at += 24;
  buffer.writeUInt32LE(0x2, at);
  buffer.writeUInt32LE(24, at + 4);
  buffer.writeUInt32LE(symOffset, at + 8);
  buffer.writeUInt32LE(symbols.length, at + 12);
  buffer.writeUInt32LE(strOffset, at + 16);
  buffer.writeUInt32LE(strings.length, at + 20);
  at += 24;
  buffer.writeUInt32LE(0x26, at);
  buffer.writeUInt32LE(16, at + 4);
  buffer.writeUInt32LE(startsOffset, at + 8);
  buffer.writeUInt32LE(startsBytes.length, at + 12);
  text.copy(buffer, textOffset);
  Buffer.from(startsBytes).copy(buffer, startsOffset);
  symbols.forEach((s, i) => {
    const e = symOffset + i * 16;
    buffer.writeUInt32LE(strx[i], e);
    buffer[e + 4] = s.type ?? 0x0f;
    buffer[e + 5] = s.sect ?? 1;
    buffer.writeBigUInt64LE(BigInt(s.address), e + 8);
  });
  Buffer.from(strings).copy(buffer, strOffset);
  return buffer;
}

export function fat(slices) {
  const header = Buffer.alloc(8 + slices.length * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(slices.length, 4);
  let offset = align(header.length, 0x4000);
  const parts = [header];
  let end = header.length;
  slices.forEach((slice, i) => {
    header.writeInt32BE(slice.readInt32LE(4), 8 + i * 20);
    header.writeUInt32BE(offset, 8 + i * 20 + 8);
    header.writeUInt32BE(slice.length, 8 + i * 20 + 12);
    header.writeUInt32BE(14, 8 + i * 20 + 16);
    parts.push(Buffer.alloc(offset - end), slice);
    end = offset + slice.length;
    offset = align(end, 0x4000);
  });
  return Buffer.concat(parts);
}

export const words = (list) => {
  const b = Buffer.alloc(list.length * 4);
  list.forEach((w, i) => b.writeUInt32LE(w >>> 0, i * 4));
  return b;
};
