const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VALUES = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) VALUES[ALPHABET.charCodeAt(i)] = i;

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  const whole = bytes.length - (bytes.length % 3);
  for (let i = 0; i < whole; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    chunk += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  const left = bytes.length - whole;
  if (left === 1) {
    const n = bytes[whole]! << 16;
    chunk += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + "==";
  } else if (left === 2) {
    const n = (bytes[whole]! << 16) | (bytes[whole + 1]! << 8);
    chunk += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + "=";
  }
  parts.push(chunk);
  return parts.join("");
}

const sextet = (text: string, at: number): number => {
  const code = text.charCodeAt(at);
  const value = code < 128 ? VALUES[code]! : -1;
  if (value < 0) throw new TypeError("That isn't base64.");
  return value;
};

export function base64ToBytes(text: string): Uint8Array {
  if (text.length % 4 !== 0) throw new TypeError("That isn't base64.");
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const last = i + 4 === text.length;
    const c = last && padding === 2 ? 0 : sextet(text, i + 2);
    const d = last && padding >= 1 ? 0 : sextet(text, i + 3);
    const n = (sextet(text, i) << 18) | (sextet(text, i + 1) << 12) | (c << 6) | d;
    out[o++] = n >> 16;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

const REPLACEMENT = 0xfffd;

export function utf8Decode(bytes: Uint8Array): string {
  const codes: number[] = [];
  const parts: string[] = [];
  const flush = () => {
    parts.push(String.fromCodePoint(...codes));
    codes.length = 0;
  };
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length) {
    const b = bytes[i]!;
    const need = b < 0x80 ? 0 : b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : -1;
    if (need < 0) {
      codes.push(REPLACEMENT);
      i++;
    } else if (need === 0) {
      codes.push(b);
      i++;
    } else {
      let cp = b & (0x3f >> need);
      let lower = b === 0xe0 ? 0xa0 : b === 0xf0 ? 0x90 : 0x80;
      let upper = b === 0xed ? 0x9f : b === 0xf4 ? 0x8f : 0xbf;
      let read = 1;
      for (; read <= need; read++) {
        const next = bytes[i + read];
        if (next === undefined || next < lower || next > upper) break;
        cp = (cp << 6) | (next & 0x3f);
        lower = 0x80;
        upper = 0xbf;
      }
      if (read > need) {
        codes.push(cp);
        i += need + 1;
      } else {
        codes.push(REPLACEMENT);
        i += read;
      }
    }
    if (codes.length >= 8192) flush();
  }
  flush();
  return parts.join("");
}
