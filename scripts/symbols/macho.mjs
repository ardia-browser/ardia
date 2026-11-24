const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const LC_SYMTAB = 0x2;
const LC_SEGMENT_64 = 0x19;
const LC_UUID = 0x1b;
const LC_FUNCTION_STARTS = 0x26;
const N_STAB = 0xe0;
const N_TYPE = 0x0e;
const N_SECT = 0x0e;
const N_EXT = 0x01;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_TYPE_X86_64 = 0x01000007;

export const ARCHES = { [CPU_TYPE_ARM64]: "arm64", [CPU_TYPE_X86_64]: "x86_64" };

const cString = (buffer, start) => {
  const end = buffer.indexOf(0, start);
  return buffer.toString("utf8", start, end < 0 ? buffer.length : end);
};

const tableString = (buffer, start, limit) => {
  const end = buffer.subarray(0, limit).indexOf(0, start);
  return end < 0 ? null : buffer.toString("utf8", start, end);
};

const FIXED_SIZE = { [LC_SEGMENT_64]: 72, [LC_UUID]: 24, [LC_SYMTAB]: 24, [LC_FUNCTION_STARTS]: 16 };

const uuidString = (bytes) => {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

export function slices(buffer) {
  if (buffer.length < 8) throw new Error("not a Mach-O file: too short");
  const magic = buffer.readUInt32BE(0);
  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    const wide = magic === FAT_MAGIC_64;
    const count = buffer.readUInt32BE(4);
    const out = [];
    for (let i = 0; i < count; i++) {
      const at = 8 + i * (wide ? 32 : 20);
      const offset = wide ? Number(buffer.readBigUInt64BE(at + 8)) : buffer.readUInt32BE(at + 8);
      const size = wide ? Number(buffer.readBigUInt64BE(at + 16)) : buffer.readUInt32BE(at + 12);
      if (offset + size > buffer.length) throw new Error("not a Mach-O file: a fat slice runs past the end");
      out.push(buffer.subarray(offset, offset + size));
    }
    return out;
  }
  if (buffer.readUInt32LE(0) === MH_MAGIC_64) return [buffer];
  throw new Error("not a 64-bit Mach-O file");
}

export function parseImage(slice) {
  if (slice.readUInt32LE(0) !== MH_MAGIC_64) throw new Error("not a 64-bit Mach-O slice");
  const cpu = slice.readInt32LE(4);
  const ncmds = slice.readUInt32LE(16);
  const commandsEnd = 32 + slice.readUInt32LE(20);
  if (commandsEnd > slice.length) throw new Error("not a Mach-O file: its load commands run past the end");
  const image = { arch: ARCHES[cpu] ?? `cpu${cpu}`, uuid: null, base: null, text: null, symtab: null, functionStarts: null };
  let at = 32;
  let sectionIndex = 0;
  for (let i = 0; i < ncmds; i++) {
    if (at + 8 > commandsEnd) throw new Error("not a Mach-O file: load commands run past sizeofcmds");
    const cmd = slice.readUInt32LE(at);
    const size = slice.readUInt32LE(at + 4);
    if (size < (FIXED_SIZE[cmd] ?? 8) || at + size > commandsEnd) throw new Error("not a Mach-O file: a load command has a bad size");
    if (cmd === LC_SEGMENT_64) {
      const segment = cString(slice.subarray(at + 8, at + 24), 0);
      const vmaddr = Number(slice.readBigUInt64LE(at + 24));
      const nsects = slice.readUInt32LE(at + 64);
      if (72 + nsects * 80 > size) throw new Error("not a Mach-O file: a segment's sections run past its load command");
      if (segment === "__TEXT") image.base = vmaddr;
      for (let s = 0; s < nsects; s++) {
        const sect = at + 72 + s * 80;
        sectionIndex++;
        const name = cString(slice.subarray(sect, sect + 16), 0);
        const owner = cString(slice.subarray(sect + 16, sect + 32), 0);
        if (owner === "__TEXT" && name === "__text") {
          image.text = {
            index: sectionIndex,
            addr: Number(slice.readBigUInt64LE(sect + 32)),
            size: Number(slice.readBigUInt64LE(sect + 40)),
            fileOffset: slice.readUInt32LE(sect + 48),
          };
        }
      }
    } else if (cmd === LC_UUID) {
      image.uuid = uuidString(slice.subarray(at + 8, at + 24));
    } else if (cmd === LC_SYMTAB) {
      image.symtab = { symoff: slice.readUInt32LE(at + 8), nsyms: slice.readUInt32LE(at + 12), stroff: slice.readUInt32LE(at + 16), strsize: slice.readUInt32LE(at + 20) };
    } else if (cmd === LC_FUNCTION_STARTS) {
      image.functionStarts = { dataoff: slice.readUInt32LE(at + 8), datasize: slice.readUInt32LE(at + 12) };
    }
    at += size;
  }
  return image;
}

export function imageFor(buffer, uuid, arch) {
  for (const slice of slices(buffer)) {
    const image = parseImage(slice);
    if ((!uuid || image.uuid === uuid) && (!arch || image.arch === arch)) return { slice, image };
  }
  return null;
}

const LOCAL_LABEL = /^(ltmp\d+|l_.*|L.*)$/;

export function functionSymbols(slice, image) {
  if (!image.symtab || !image.text) return [];
  const { symoff, nsyms, stroff, strsize } = image.symtab;
  if (symoff + nsyms * 16 > slice.length || stroff + strsize > slice.length) throw new Error("the symbol table runs past the end of the file");
  const out = [];
  for (let i = 0; i < nsyms; i++) {
    const at = symoff + i * 16;
    const strx = slice.readUInt32LE(at);
    const type = slice[at + 4];
    const sect = slice[at + 5];
    if (type & N_STAB || (type & N_TYPE) !== N_SECT || sect !== image.text.index || strx >= strsize) continue;
    const name = tableString(slice, stroff + strx, stroff + strsize);
    if (!name || LOCAL_LABEL.test(name)) continue;
    out.push({ address: Number(slice.readBigUInt64LE(at + 8)), name, external: Boolean(type & N_EXT), order: i });
  }
  return out;
}

export function functionStarts(slice, image) {
  if (!image.functionStarts || image.base == null) return [];
  const { dataoff, datasize } = image.functionStarts;
  const end = dataoff + datasize;
  if (end > slice.length) throw new Error("not a Mach-O file: the function starts run past the end");
  const out = [];
  let address = image.base;
  let at = dataoff;
  while (at < end) {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= end || shift > 63) throw new Error("not a Mach-O file: a function start is cut off");
      const byte = slice[at++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    if (value === 0) break;
    address += value;
    out.push(address);
  }
  return out;
}
