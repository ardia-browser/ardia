import { WASM_CHUNK, wasmCompressor } from "./sha256Wasm";

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private block = new Uint8Array(64);
  private filled = 0;
  private total = 0;

  update(data: Uint8Array): this {
    let i = 0;
    this.total += data.length;
    if (this.filled > 0) {
      const take = Math.min(64 - this.filled, data.length);
      this.block.set(data.subarray(0, take), this.filled);
      this.filled += take;
      i = take;
      if (this.filled === 64) {
        compressBlocks(this.h, this.block, 0, 64);
        this.filled = 0;
      }
    }
    const end = i + ((data.length - i) & ~63);
    if (end > i) compressRange(this.h, data, i, end);
    i = end;
    if (i < data.length) {
      this.block.set(data.subarray(i), 0);
      this.filled = data.length - i;
    }
    return this;
  }

  digest(): Uint8Array {
    const bits = this.total * 8;
    const pad = new Uint8Array((this.filled < 56 ? 56 : 120) - this.filled + 8);
    pad[0] = 0x80;
    const hi = Math.floor(bits / 0x100000000);
    const lo = bits >>> 0;
    const n = pad.length;
    pad[n - 8] = hi >>> 24;
    pad[n - 7] = (hi >>> 16) & 255;
    pad[n - 6] = (hi >>> 8) & 255;
    pad[n - 5] = hi & 255;
    pad[n - 4] = lo >>> 24;
    pad[n - 3] = (lo >>> 16) & 255;
    pad[n - 2] = (lo >>> 8) & 255;
    pad[n - 1] = lo & 255;
    const total = this.total;
    this.update(pad);
    this.total = total;
    const out = new Uint8Array(32);
    for (let j = 0; j < 8; j++) {
      const v = this.h[j]!;
      out[j * 4] = v >>> 24;
      out[j * 4 + 1] = (v >>> 16) & 255;
      out[j * 4 + 2] = (v >>> 8) & 255;
      out[j * 4 + 3] = v & 255;
    }
    return out;
  }
}

const WASM_FROM = 4096;

let useWasm = true;

export function preferScriptSha256(script: boolean) {
  useWasm = !script;
}

function compressRange(state: Int32Array, data: Uint8Array, start: number, end: number) {
  const wasm = useWasm && end - start >= WASM_FROM ? wasmCompressor() : null;
  if (!wasm) return compressBlocks(state, data, start, end);
  wasm.state.set(state);
  for (let at = start; at < end; at += WASM_CHUNK) {
    const n = Math.min(WASM_CHUNK, end - at);
    wasm.memory.set(data.subarray(at, at + n));
    wasm.compress(n >> 6);
  }
  state.set(wasm.state);
}

const W = new Int32Array(64);

function compressBlocks(state: Int32Array, data: Uint8Array, start: number, end: number) {
  const w = W;
  const k = K;
  let a = state[0]!;
  let b = state[1]!;
  let c = state[2]!;
  let d = state[3]!;
  let e = state[4]!;
  let f = state[5]!;
  let g = state[6]!;
  let h = state[7]!;
  for (let i = start; i + 64 <= end; i += 64) {
    for (let t = 0, j = i; t < 16; t++, j += 4) w[t] = (data[j]! << 24) | (data[j + 1]! << 16) | (data[j + 2]! << 8) | data[j + 3]!;
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15]!;
      const y = w[t - 2]!;
      w[t] = (w[t - 16]! + (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + w[t - 7]! + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))) | 0;
    }
    const a0 = a;
    const b0 = b;
    const c0 = c;
    const d0 = d;
    const e0 = e;
    const f0 = f;
    const g0 = g;
    const h0 = h;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + (g ^ (e & (f ^ g))) + k[t]! + w[t]!) | 0;
      const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) | (c & (a | b)))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    a = (a + a0) | 0;
    b = (b + b0) | 0;
    c = (c + c0) | 0;
    d = (d + d0) | 0;
    e = (e + e0) | 0;
    f = (f + f0) | 0;
    g = (g + g0) | 0;
    h = (h + h0) | 0;
  }
  state[0] = a;
  state[1] = b;
  state[2] = c;
  state[3] = d;
  state[4] = e;
  state[5] = f;
  state[6] = g;
  state[7] = h;
}
