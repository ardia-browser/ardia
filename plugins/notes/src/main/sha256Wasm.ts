const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const OP = {
  block: 0x02,
  loop: 0x03,
  br: 0x0c,
  brIf: 0x0d,
  end: 0x0b,
  localGet: 0x20,
  localSet: 0x21,
  localTee: 0x22,
  i32Load: 0x28,
  i32Store: 0x36,
  i32Const: 0x41,
  i32Eqz: 0x45,
  i32Add: 0x6a,
  i32Sub: 0x6b,
  i32And: 0x71,
  i32Or: 0x72,
  i32Xor: 0x73,
  i32ShrU: 0x76,
  i32Rotl: 0x77,
  i32Rotr: 0x78,
} as const;

const VOID = 0x40;

export const WASM_STATE = 0;
export const WASM_DATA = 64;
export const WASM_CHUNK = 1024 * 1024;
const PAGES = Math.ceil((WASM_DATA + WASM_CHUNK) / 65536);

const PARAM_STATE = 0;
const PARAM_DATA = 1;
const PARAM_BLOCKS = 2;
const VARS = 3;
const SAVED = VARS + 8;
const WORDS = SAVED + 8;
const T1 = WORDS + 16;
const SWAP = T1 + 1;
const LOCALS = SWAP + 1 - VARS;

function unsigned(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}

function signed(value: number): number[] {
  const out: number[] = [];
  let v = value | 0;
  for (;;) {
    const byte = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0)) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

class Code {
  readonly bytes: number[] = [];
  op(...codes: number[]): this {
    this.bytes.push(...codes);
    return this;
  }
  get(local: number): this {
    return this.op(OP.localGet, ...unsigned(local));
  }
  set(local: number): this {
    return this.op(OP.localSet, ...unsigned(local));
  }
  tee(local: number): this {
    return this.op(OP.localTee, ...unsigned(local));
  }
  num(value: number): this {
    return this.op(OP.i32Const, ...signed(value));
  }
  load(offset: number): this {
    return this.op(OP.i32Load, 2, ...unsigned(offset));
  }
  store(offset: number): this {
    return this.op(OP.i32Store, 2, ...unsigned(offset));
  }
  rotr(local: number, bits: number): this {
    return this.get(local).num(bits).op(OP.i32Rotr);
  }
  shr(local: number, bits: number): this {
    return this.get(local).num(bits).op(OP.i32ShrU);
  }
  threeRotations(local: number, a: number, b: number, c: number, shift = false): this {
    this.rotr(local, a).rotr(local, b).op(OP.i32Xor);
    return (shift ? this.shr(local, c) : this.rotr(local, c)).op(OP.i32Xor);
  }
}

function compressBody(): number[] {
  const code = new Code();
  const v = (role: number, round: number) => VARS + ((role - (round % 8) + 8) % 8);
  for (let i = 0; i < 8; i++) code.get(PARAM_STATE).load(i * 4).set(VARS + i);
  code.op(OP.block, VOID, OP.loop, VOID);
  code.get(PARAM_BLOCKS).op(OP.i32Eqz, OP.brIf, 1);
  for (let i = 0; i < 8; i++) code.get(VARS + i).set(SAVED + i);
  for (let t = 0; t < 16; t++) {
    code.get(PARAM_DATA).load(t * 4).tee(SWAP).num(8).op(OP.i32Rotr).num(0xff00ff00 | 0).op(OP.i32And);
    code.get(SWAP).num(8).op(OP.i32Rotl).num(0x00ff00ff).op(OP.i32And).op(OP.i32Or).set(WORDS + t);
  }
  for (let t = 0; t < 64; t++) {
    const w = WORDS + (t % 16);
    if (t >= 16) {
      const x15 = WORDS + ((t - 15) % 16);
      const x2 = WORDS + ((t - 2) % 16);
      const x7 = WORDS + ((t - 7) % 16);
      code.get(w).threeRotations(x15, 7, 18, 3, true).op(OP.i32Add);
      code.get(x7).op(OP.i32Add).threeRotations(x2, 17, 19, 10, true).op(OP.i32Add).set(w);
    }
    const [a, b, c, d, e, f, g, h] = [0, 1, 2, 3, 4, 5, 6, 7].map((role) => v(role, t)) as [number, number, number, number, number, number, number, number];
    code.get(h).threeRotations(e, 6, 11, 25).op(OP.i32Add);
    code.get(g).get(e).get(f).get(g).op(OP.i32Xor, OP.i32And, OP.i32Xor, OP.i32Add);
    code.num(K[t]! | 0).op(OP.i32Add).get(w).op(OP.i32Add).set(T1);
    code.get(d).get(T1).op(OP.i32Add).set(d);
    code.get(T1).threeRotations(a, 2, 13, 22).op(OP.i32Add);
    code.get(a).get(b).op(OP.i32And).get(c).get(a).get(b).op(OP.i32Or, OP.i32And, OP.i32Or, OP.i32Add).set(h);
  }
  for (let i = 0; i < 8; i++) code.get(VARS + i).get(SAVED + i).op(OP.i32Add).set(VARS + i);
  code.get(PARAM_DATA).num(64).op(OP.i32Add).set(PARAM_DATA);
  code.get(PARAM_BLOCKS).num(1).op(OP.i32Sub).set(PARAM_BLOCKS);
  code.op(OP.br, 0, OP.end, OP.end);
  for (let i = 0; i < 8; i++) code.get(PARAM_STATE).get(VARS + i).store(i * 4);
  code.op(OP.end);
  return code.bytes;
}

const section = (id: number, body: number[]) => [id, ...unsigned(body.length), ...body];
const name = (text: string) => [...unsigned(text.length), ...Array.from(text, (c) => c.charCodeAt(0))];

export function sha256Module(): Uint8Array {
  const body = [1, ...unsigned(LOCALS), 0x7f, ...compressBody()];
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, 0x60, 3, 0x7f, 0x7f, 0x7f, 0]),
    ...section(3, [1, 0]),
    ...section(5, [1, 0, ...unsigned(PAGES)]),
    ...section(7, [2, ...name("compress"), 0, 0, ...name("memory"), 2, 0]),
    ...section(10, [1, ...unsigned(body.length), ...body]),
  ];
  return new Uint8Array(bytes);
}

export type WasmCompressor = { memory: Uint8Array; state: Int32Array; compress(blocks: number): void };

type WasmMemory = { buffer: ArrayBuffer };
type WasmExports = { compress: (state: number, data: number, blocks: number) => void; memory: WasmMemory };
type WasmApi = { Module: new (bytes: Uint8Array) => object; Instance: new (module: object, imports: object) => { exports: unknown } };

let cached: WasmCompressor | null | undefined;

export function wasmCompressor(): WasmCompressor | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    const wasm = (globalThis as { WebAssembly?: WasmApi }).WebAssembly;
    if (!wasm) return null;
    const exports = new wasm.Instance(new wasm.Module(sha256Module()), {}).exports as WasmExports;
    const buffer = exports.memory.buffer;
    cached = {
      memory: new Uint8Array(buffer, WASM_DATA, WASM_CHUNK),
      state: new Int32Array(buffer, WASM_STATE, 8),
      compress: (blocks) => exports.compress(WASM_STATE, WASM_DATA, blocks),
    };
  } catch {
    cached = null;
  }
  return cached;
}
