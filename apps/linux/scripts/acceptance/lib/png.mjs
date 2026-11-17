import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 2: 3, 6: 4 };

export function hasPngSignature(buffer) {
  return buffer.length >= SIGNATURE.length && buffer.subarray(0, SIGNATURE.length).equals(SIGNATURE);
}

function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[(y - 1) * stride + x - channels] : 0;
      let predictor;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else throw new Error(`PNG scanline ${y} has filter ${filter}`);
      out[y * stride + x] = (line[x] + predictor) & 0xff;
    }
  }
  return out;
}

export function decodePng(buffer) {
  if (!hasPngSignature(buffer)) throw new Error("the file does not start with the PNG signature");
  let header = null;
  const data = [];
  for (let at = SIGNATURE.length; at + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString("latin1", at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9], interlace: body[12] };
    else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (!header) throw new Error("the PNG has no IHDR chunk");
  const channels = CHANNELS[header.colorType];
  if (header.depth !== 8 || !channels || header.interlace !== 0) {
    throw new Error(`the PNG is ${header.depth}-bit, colour type ${header.colorType}, interlace ${header.interlace}; only 8-bit RGB and RGBA are read`);
  }
  const { width, height } = header;
  const raw = inflateSync(Buffer.concat(data));
  if (raw.length !== (width * channels + 1) * height) throw new Error(`the PNG's pixel data is ${raw.length} bytes, not ${(width * channels + 1) * height}`);
  const samples = unfilter(raw, width, height, channels);
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels.set(samples.subarray(i * channels, i * channels + channels), i * 4);
    if (channels === 3) pixels[i * 4 + 3] = 255;
  }
  return { width, height, pixels };
}

export function distinctColors({ width, height, pixels }, { x = 0, y = 0, w = width, h = height } = {}, limit = 16) {
  const seen = new Set();
  for (let row = Math.max(0, y); row < Math.min(height, y + h) && seen.size < limit; row++) {
    for (let column = Math.max(0, x); column < Math.min(width, x + w) && seen.size < limit; column++) {
      const at = (row * width + column) * 4;
      seen.add((pixels[at] << 24) | (pixels[at + 1] << 16) | (pixels[at + 2] << 8) | pixels[at + 3]);
    }
  }
  return seen.size;
}

export function minimumAlpha({ width, height, pixels }) {
  let least = 255;
  for (let i = 3; i < width * height * 4 && least > 0; i += 4) least = Math.min(least, pixels[i]);
  return least;
}
