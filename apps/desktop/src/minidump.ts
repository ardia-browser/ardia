const SIGNATURE = 0x504d444d;
const THREAD_LIST = 3;
const MODULE_LIST = 4;
const MEMORY_LIST = 5;
const EXCEPTION = 6;
const SYSTEM_INFO = 7;
const MISC_INFO = 15;
const CRASHPAD_INFO = 0x43500001;
const ELF_BUILD_ID = 0x4270454c;
const MISC_PROCESS_TIMES = 0x2;
const ANNOTATION_STRING = 1;
const AMD64 = 9;
const AMD64_CONTEXT_BYTES = 0x100;
const AMD64_RSP = 0x98;
const AMD64_RBP = 0xa0;
const AMD64_RIP = 0xf8;
const MAX_FRAMES = 64;
const SCAN_BYTES = 0x10000n;
const MAX_COUNT = 4096;
const MODULE_RECORD_BYTES = 108;
const MAX_STRING_BYTES = 4096;
const MAX_BUILD_ID_BYTES = 64;

export type MinidumpModule = { base: bigint; size: number; path: string; buildId: string | null };
type MinidumpException = { signal: number; code: number; threadId: number; address: bigint | null; parameter: bigint | null };
type MinidumpFrame = { module: MinidumpModule | null; address: bigint };

export type Minidump = {
  time: number;
  platform: number | null;
  processStart: number | null;
  amd64: boolean;
  exception: MinidumpException | null;
  modules: MinidumpModule[];
  annotations: Record<string, string>;
  frames: MinidumpFrame[];
};

class Reader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  fits(offset: number, length: number) {
    return Number.isSafeInteger(offset) && offset >= 0 && length >= 0 && offset + length <= this.bytes.byteLength;
  }
  u16(offset: number) {
    return this.fits(offset, 2) ? this.view.getUint16(offset, true) : null;
  }
  u32(offset: number) {
    return this.fits(offset, 4) ? this.view.getUint32(offset, true) : null;
  }
  u64(offset: number) {
    return this.fits(offset, 8) ? this.view.getBigUint64(offset, true) : null;
  }
  slice(offset: number, length: number) {
    return this.fits(offset, length) ? this.bytes.subarray(offset, offset + length) : null;
  }
  utf16(rva: number) {
    const length = this.u32(rva);
    const text = length === null || length % 2 || length > MAX_STRING_BYTES ? null : this.slice(rva + 4, length);
    return text ? new TextDecoder("utf-16le").decode(text) : null;
  }
  utf8(rva: number) {
    const length = this.u32(rva);
    const text = length === null || length > MAX_STRING_BYTES ? null : this.slice(rva + 4, length);
    return text ? new TextDecoder().decode(text) : null;
  }
}

type Region = { start: bigint; bytes: Uint8Array };

function readMemory(regions: Region[], address: bigint): bigint | null {
  for (const region of regions) {
    const offset = address - region.start;
    if (offset < 0n || offset + 8n > BigInt(region.bytes.byteLength)) continue;
    return new DataView(region.bytes.buffer, region.bytes.byteOffset + Number(offset), 8).getBigUint64(0, true);
  }
  return null;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

function streams(reader: Reader) {
  const found = new Map<number, { size: number; rva: number }>();
  if (reader.u32(0) !== SIGNATURE) return null;
  const count = reader.u32(8);
  const directory = reader.u32(12);
  if (count === null || directory === null || count > MAX_COUNT) return null;
  for (let index = 0; index < count; index++) {
    const type = reader.u32(directory + index * 12);
    const size = reader.u32(directory + index * 12 + 4);
    const rva = reader.u32(directory + index * 12 + 8);
    if (type === null || size === null || rva === null) return null;
    if (!found.has(type) && reader.fits(rva, size)) found.set(type, { size, rva });
  }
  return found;
}

function modules(reader: Reader, stream: { size: number; rva: number } | undefined): MinidumpModule[] {
  const count = stream === undefined ? null : reader.u32(stream.rva);
  if (stream === undefined || count === null || count > MAX_COUNT || 4 + count * MODULE_RECORD_BYTES > stream.size) return [];
  const list: MinidumpModule[] = [];
  for (let index = 0; index < count; index++) {
    const at = stream.rva + 4 + index * MODULE_RECORD_BYTES;
    const base = reader.u64(at);
    const size = reader.u32(at + 8);
    const name = reader.u32(at + 20);
    if (base === null || size === null || name === null) break;
    const cvSize = reader.u32(at + 76) ?? 0;
    const cvRva = reader.u32(at + 80) ?? 0;
    const buildId = cvSize > 4 && cvSize - 4 <= MAX_BUILD_ID_BYTES && reader.u32(cvRva) === ELF_BUILD_ID ? reader.slice(cvRva + 4, cvSize - 4) : null;
    list.push({ base, size, path: reader.utf16(name) ?? "", buildId: buildId?.length ? hex(buildId) : null });
  }
  return list;
}

function dictionary(reader: Reader, rva: number, into: Record<string, string>) {
  const count = reader.u32(rva);
  if (count === null || count > MAX_COUNT) return;
  for (let index = 0; index < count; index++) {
    const key = reader.u32(rva + 4 + index * 8);
    const value = reader.u32(rva + 8 + index * 8);
    if (key === null || value === null) return;
    const name = reader.utf8(key);
    const text = reader.utf8(value);
    if (name && text !== null) into[name] = text;
  }
}

function annotationObjects(reader: Reader, rva: number, into: Record<string, string>) {
  const count = reader.u32(rva);
  if (count === null || count > MAX_COUNT) return;
  for (let index = 0; index < count; index++) {
    const at = rva + 4 + index * 12;
    const name = reader.u32(at);
    const type = reader.u16(at + 4);
    const value = reader.u32(at + 8);
    if (name === null || type !== ANNOTATION_STRING || value === null) continue;
    const key = reader.utf8(name);
    const length = reader.u32(value);
    const data = length === null || length > MAX_STRING_BYTES ? null : reader.slice(value + 4, length);
    if (key && data) into[key] = new TextDecoder().decode(data).replace(/\0+$/, "");
  }
}

function annotations(reader: Reader, rva: number | undefined) {
  const found: Record<string, string> = {};
  if (rva === undefined) return found;
  const simpleSize = reader.u32(rva + 36) ?? 0;
  const simple = reader.u32(rva + 40) ?? 0;
  if (simpleSize) dictionary(reader, simple, found);
  const listSize = reader.u32(rva + 44) ?? 0;
  const list = reader.u32(rva + 48) ?? 0;
  const count = listSize ? reader.u32(list) : null;
  if (count === null || count > MAX_COUNT) return found;
  for (let index = 0; index < count; index++) {
    const at = list + 4 + index * 12;
    const location = reader.u32(at + 8);
    if (location === null) break;
    if ((reader.u32(location + 12) ?? 0) > 0) dictionary(reader, reader.u32(location + 16) ?? 0, found);
    if ((reader.u32(location + 20) ?? 0) > 0) annotationObjects(reader, reader.u32(location + 24) ?? 0, found);
  }
  return found;
}

function memory(reader: Reader, threadList: number | undefined, memoryList: number | undefined): Region[] {
  const regions: Region[] = [];
  const threads = threadList === undefined ? null : reader.u32(threadList);
  if (threadList !== undefined && threads !== null && threads <= MAX_COUNT) {
    for (let index = 0; index < threads; index++) {
      const at = threadList + 4 + index * 48;
      const start = reader.u64(at + 24);
      const size = reader.u32(at + 32);
      const rva = reader.u32(at + 36);
      const bytes = size === null || rva === null ? null : reader.slice(rva, size);
      if (start !== null && bytes) regions.push({ start, bytes });
    }
  }
  const ranges = memoryList === undefined ? null : reader.u32(memoryList);
  if (memoryList !== undefined && ranges !== null && ranges <= MAX_COUNT) {
    for (let index = 0; index < ranges; index++) {
      const at = memoryList + 4 + index * 16;
      const start = reader.u64(at);
      const size = reader.u32(at + 8);
      const rva = reader.u32(at + 12);
      const bytes = size === null || rva === null ? null : reader.slice(rva, size);
      if (start !== null && bytes) regions.push({ start, bytes });
    }
  }
  return regions;
}

function moduleAt(list: MinidumpModule[], address: bigint) {
  return list.find((module) => address >= module.base && address < module.base + BigInt(module.size)) ?? null;
}

function walk(reader: Reader, context: { size: number; rva: number } | null, list: MinidumpModule[], regions: Region[]): MinidumpFrame[] {
  if (!context || context.size < AMD64_CONTEXT_BYTES) return [];
  const pc = reader.u64(context.rva + AMD64_RIP);
  const sp = reader.u64(context.rva + AMD64_RSP);
  const fp = reader.u64(context.rva + AMD64_RBP);
  if (pc === null || sp === null || fp === null) return [];
  const frames: MinidumpFrame[] = [{ module: moduleAt(list, pc), address: pc }];
  const follow = (start: bigint, floor: bigint) => {
    let frame = start;
    let low = floor;
    while (frames.length < MAX_FRAMES && frame >= low && frame % 8n === 0n) {
      const caller = readMemory(regions, frame);
      const returnAddress = readMemory(regions, frame + 8n);
      if (caller === null || returnAddress === null) break;
      const module = moduleAt(list, returnAddress);
      if (!module) break;
      frames.push({ module, address: returnAddress });
      if (caller <= frame) break;
      low = frame + 16n;
      frame = caller;
    }
  };
  follow(fp, sp);
  if (frames.length === 1) {
    const record = firstFrameRecord(list, regions, sp);
    if (record !== null) follow(record, sp);
  }
  return frames;
}

function firstFrameRecord(list: MinidumpModule[], regions: Region[], sp: bigint): bigint | null {
  for (let slot = sp - (sp % 8n); slot < sp + SCAN_BYTES; slot += 8n) {
    const caller = readMemory(regions, slot);
    const returnAddress = readMemory(regions, slot + 8n);
    if (caller === null || returnAddress === null) return null;
    if (caller <= slot || caller - slot > SCAN_BYTES || caller % 8n || !moduleAt(list, returnAddress)) continue;
    const next = readMemory(regions, caller + 8n);
    if (next !== null && moduleAt(list, next)) return slot;
  }
  return null;
}

export function parseMinidump(bytes: Uint8Array): Minidump | null {
  const reader = new Reader(bytes);
  const found = streams(reader);
  if (!found) return null;
  const seconds = reader.u32(20);
  if (seconds === null) return null;
  const misc = found.get(MISC_INFO);
  const flags = misc && misc.size >= 16 ? reader.u32(misc.rva + 4) : null;
  const created = flags !== null && flags & MISC_PROCESS_TIMES ? reader.u32(misc!.rva + 12) : null;
  const system = found.get(SYSTEM_INFO);
  const amd64 = !!system && reader.u16(system.rva) === AMD64;
  const platform = system && system.size >= 24 ? reader.u32(system.rva + 20) : null;
  const list = modules(reader, found.get(MODULE_LIST));
  const thrown = found.get(EXCEPTION);
  let exception: MinidumpException | null = null;
  let context: { size: number; rva: number } | null = null;
  if (thrown && thrown.size >= 168) {
    const threadId = reader.u32(thrown.rva);
    const signal = reader.u32(thrown.rva + 8);
    const code = reader.u32(thrown.rva + 12);
    const contextSize = reader.u32(thrown.rva + 160);
    const contextRva = reader.u32(thrown.rva + 164);
    const parameters = reader.u32(thrown.rva + 32);
    const address = reader.u64(thrown.rva + 24);
    const parameter = parameters ? reader.u64(thrown.rva + 40) : null;
    if (threadId !== null && signal !== null && code !== null) exception = { signal, code: code | 0, threadId, address, parameter };
    if (contextSize !== null && contextRva !== null && reader.fits(contextRva, contextSize)) context = { size: contextSize, rva: contextRva };
  }
  const regions = memory(reader, found.get(THREAD_LIST)?.rva, found.get(MEMORY_LIST)?.rva);
  return {
    time: seconds * 1000,
    platform,
    processStart: created ? created * 1000 : null,
    amd64,
    exception,
    modules: list,
    annotations: annotations(reader, found.get(CRASHPAD_INFO)?.rva),
    frames: amd64 ? walk(reader, context, list, regions) : [],
  };
}
