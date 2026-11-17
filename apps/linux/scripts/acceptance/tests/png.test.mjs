import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateSync } from "node:zlib";
import { decodePng, distinctColors, hasPngSignature, minimumAlpha } from "../lib/png.mjs";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "latin1");
  body.copy(out, 8);
  return out;
}

function png({ width, height, colorType = 6, rows, filters = rows.map(() => 0) }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  const raw = Buffer.concat(rows.map((row, y) => Buffer.from([filters[y], ...row])));
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

describe("the acceptance suite's PNG reader", () => {
  it("recognises the signature and refuses anything else", () => {
    assert.equal(hasPngSignature(SIGNATURE), true);
    assert.equal(hasPngSignature(Buffer.from("not a png at all")), false);
    assert.equal(hasPngSignature(Buffer.alloc(3)), false);
    assert.throws(() => decodePng(Buffer.from("<html>")), /PNG signature/);
  });

  it("reads RGBA pixels and tells opaque from see-through", () => {
    const picture = decodePng(png({ width: 2, height: 2, rows: [[255, 0, 0, 255, 0, 255, 0, 255], [0, 0, 255, 255, 0, 0, 0, 0]] }));
    assert.equal(picture.width, 2);
    assert.equal(picture.height, 2);
    assert.deepEqual([...picture.pixels.subarray(0, 4)], [255, 0, 0, 255]);
    assert.deepEqual([...picture.pixels.subarray(12, 16)], [0, 0, 0, 0]);
    assert.equal(minimumAlpha(picture), 0);
    assert.equal(distinctColors(picture), 4);
    assert.equal(distinctColors(picture, { x: 0, y: 0, w: 1, h: 1 }), 1);
  });

  it("reads RGB pictures as opaque", () => {
    const picture = decodePng(png({ width: 2, height: 1, colorType: 2, rows: [[10, 20, 30, 10, 20, 30]] }));
    assert.deepEqual([...picture.pixels], [10, 20, 30, 255, 10, 20, 30, 255]);
    assert.equal(minimumAlpha(picture), 255);
    assert.equal(distinctColors(picture), 1);
  });

  it("undoes the sub, up, average and Paeth filters", () => {
    const first = [10, 20, 30, 255, 40, 60, 80, 255];
    const second = [11, 22, 33, 255, 44, 66, 88, 255];
    const sub = (row) => row.map((v, i) => (v - (i >= 4 ? row[i - 4] : 0)) & 255);
    const up = (row, above) => row.map((v, i) => (v - above[i]) & 255);
    const average = (row, above) => row.map((v, i) => (v - (((i >= 4 ? row[i - 4] : 0) + above[i]) >> 1)) & 255);
    const paeth = (row, above) => row.map((v, i) => {
      const a = i >= 4 ? row[i - 4] : 0;
      const b = above[i];
      const c = i >= 4 ? above[i - 4] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      return (v - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
    });
    const rows = [sub(first), up(second, first), average(first, second), paeth(second, first)];
    const picture = decodePng(png({ width: 2, height: 4, rows, filters: [1, 2, 3, 4] }));
    assert.deepEqual([...picture.pixels], [...first, ...second, ...first, ...second]);
  });

  it("refuses forms it does not read", () => {
    const interlaced = png({ width: 1, height: 1, rows: [[0, 0, 0, 255]] });
    interlaced[8 + 8 + 12] = 1;
    assert.throws(() => decodePng(interlaced), /interlace 1/);
    assert.throws(() => decodePng(png({ width: 1, height: 1, colorType: 0, rows: [[0]] })), /colour type 0/);
  });
});
