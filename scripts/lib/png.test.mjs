import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { decodePng, encodePng, toRgba } from "./png.mjs";

test("an encoded RGBA image decodes to the same pixels", () => {
  const width = 3, height = 2;
  const rgba = Buffer.from(Array.from({ length: width * height * 4 }, (_, i) => (i * 37) & 255));
  const png = decodePng(encodePng({ width, height, rgba }));
  assert.deepEqual([png.width, png.height, png.channels], [width, height, 4]);
  assert.deepEqual(png.data, rgba);
  assert.deepEqual(toRgba(png).rgba, rgba);
});

test("every row filter undoes, and grey with alpha widens to RGBA", () => {
  const width = 2, height = 5, channels = 2;
  const pixels = [[10, 200, 30, 40], [50, 60, 70, 80], [90, 100, 110, 120], [130, 140, 150, 160], [170, 180, 190, 255]];
  const raw = [];
  let prior = [0, 0, 0, 0];
  pixels.forEach((row, filter) => {
    const left = (i) => (i >= channels ? row[i - channels] : 0);
    const upLeft = (i) => (i >= channels ? prior[i - channels] : 0);
    const predict = (i) => {
      const a = left(i), b = prior[i], c = upLeft(i);
      if (filter === 1) return a;
      if (filter === 2) return b;
      if (filter === 3) return (a + b) >> 1;
      if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      return 0;
    };
    raw.push(filter, ...row.map((v, i) => (v - predict(i)) & 255));
    prior = row;
  });
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, "ascii");
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 4;
  const file = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(raw))), chunk("IEND", Buffer.alloc(0))]);
  const png = decodePng(file);
  assert.deepEqual([...png.data], pixels.flat());
  assert.deepEqual([...toRgba(png).rgba.subarray(0, 8)], [10, 10, 10, 200, 30, 30, 30, 40]);
});

test("a 16-bit PNG is refused by name", () => {
  const ihdr = Buffer.alloc(13);
  ihdr[8] = 16;
  ihdr[9] = 6;
  const head = Buffer.alloc(8);
  head.writeUInt32BE(13);
  head.write("IHDR", 4, "ascii");
  const file = Buffer.concat([Buffer.alloc(8), head, ihdr, Buffer.alloc(4)]);
  assert.throws(() => decodePng(file, "deep.png"), /deep\.png: only 8-bit non-interlaced PNGs/);
});
