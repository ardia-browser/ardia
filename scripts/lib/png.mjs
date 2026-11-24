import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decodePng(buf, name = "PNG") {
  let width = 0, height = 0, channels = 4;
  const idat = [];
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at), type = buf.toString("ascii", at + 4, at + 8);
    if (type === "IHDR") {
      width = buf.readUInt32BE(at + 8);
      height = buf.readUInt32BE(at + 12);
      if (buf[at + 16] !== 8 || buf[at + 20] !== 0) throw new Error(`${name}: only 8-bit non-interlaced PNGs`);
      channels = CHANNELS[buf[at + 17]];
    } else if (type === "IDAT") idat.push(buf.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = y * stride, src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= channels ? data[row + x - channels] : 0;
      const b = y ? data[row - stride + x] : 0;
      const c = y && x >= channels ? data[row - stride + x - channels] : 0;
      let p;
      if (filter === 0) p = v;
      else if (filter === 1) p = v + a;
      else if (filter === 2) p = v + b;
      else if (filter === 3) p = v + ((a + b) >> 1);
      else {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      data[row + x] = p & 255;
    }
  }
  return { width, height, channels, data };
}

export const readPng = (path) => decodePng(readFileSync(path), path);

export function toRgba({ width, height, channels, data }) {
  const rgba = Buffer.alloc(width * height * 4);
  const grey = channels <= 2;
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    rgba[i * 4] = data[s];
    rgba[i * 4 + 1] = grey ? data[s] : data[s + 1];
    rgba[i * 4 + 2] = grey ? data[s] : data[s + 2];
    rgba[i * 4 + 3] = channels === 4 ? data[s + 3] : channels === 2 ? data[s + 1] : 255;
  }
  return { width, height, rgba };
}

export const readPngRgba = (path) => toRgba(readPng(path));

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
};

export function encodePng({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
