import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pageScript = readFileSync(new URL("../ios/page_script.js", import.meta.url), "utf8");
const start = pageScript.indexOf("const mp4 = (() => {");
const end = pageScript.indexOf("\n      })();\n", start);
assert.ok(start > 0 && end > start, "the page script's mp4 helpers");
const mp4 = new Function(`${pageScript.slice(start, end)}\n      })();\nreturn mp4;`)();

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const box = (type, ...parts) => {
  const body = parts.flat();
  return [...u32(body.length + 8), ...ascii(type), ...body];
};
const zeros = (n) => new Array(n).fill(0);

const init = (timescale, width, height, sampleDuration) =>
  box(
    "moov",
    box(
      "trak",
      box("tkhd", zeros(76), u32(width << 16), u32(height << 16)),
      box("mdia", box("mdhd", zeros(12), u32(timescale), zeros(8)))
    ),
    box("mvex", box("trex", zeros(12), u32(sampleDuration), zeros(8)))
  );
const fragment = (decodeTime, durations) =>
  [
    ...box(
      "moof",
      box("mfhd", zeros(8)),
      box(
        "traf",
        box("tfhd", u32(0x20000), u32(1)),
        box("tfdt", u32(0x01000000), u32(0), u32(decodeTime)),
        box("trun", u32(0x000101), u32(durations.length), u32(0), durations.flatMap((d) => u32(d)))
      )
    ),
    ...box("mdat", zeros(16)),
  ];
const bytes = (...parts) => new Uint8Array(parts.flat());

test("the protected video bridge reads a track's timescale, size and default sample duration from its init segment", () => {
  assert.deepEqual(mp4.describeInit(bytes(box("ftyp", ascii("iso6")), init(24000, 1920, 1080, 1001))), {
    timescale: 24000,
    width: 1920,
    height: 1080,
    sampleDuration: 1001,
    duration: 0,
  });
});

test("an init segment gives the duration from its movie header, or from the fragments' total when the header leaves it at 0", () => {
  const withHeaders = (mvhd, mehd) =>
    bytes(
      box(
        "moov",
        box("mvhd", ...mvhd),
        box("trak", box("mdia", box("mdhd", zeros(12), u32(24000), zeros(8)))),
        box("mvex", ...(mehd ? [box("mehd", ...mehd)] : []), box("trex", zeros(12), u32(1001), zeros(8)))
      )
    );
  assert.equal(mp4.describeInit(withHeaders([zeros(12), u32(1000), u32(2991500), zeros(80)])).duration, 2991.5);
  assert.equal(mp4.describeInit(withHeaders([zeros(12), u32(1000), u32(0), zeros(80)], [zeros(4), u32(951500)])).duration, 951.5);
  assert.equal(mp4.describeInit(withHeaders([u32(0x01000000), zeros(16), u32(90000), u32(0), u32(90000 * 60), zeros(80)])).duration, 60);
  assert.equal(mp4.describeInit(withHeaders([zeros(12), u32(1000), u32(0xffffffff), zeros(80)])).duration, 0);
});

test("a media segment's start and end come from its decode time and sample durations", () => {
  const info = mp4.describeInit(bytes(init(24000, 1920, 1080, 1001)));
  const [from, to] = mp4.fragmentTimes(bytes(fragment(48048, new Array(96).fill(1001))), info);
  assert.equal(from, 2.002);
  assert.ok(Math.abs(to - 6.006) < 1e-9);
  assert.equal(mp4.fragmentTimes(bytes(box("free", zeros(4))), info), null);
});

test("appended bytes split into whole init and media units, keeping a partial box for the next append", () => {
  const whole = bytes(box("ftyp", ascii("iso6")), init(48000, 0, 0, 1024), box("styp", ascii("msdh")), fragment(0, [1024, 1024]));
  const partial = bytes([...whole, ...fragment(2048, [1024]).slice(0, 20)]);
  const { units, rest } = mp4.split(partial);
  assert.deepEqual(
    units.map((u) => u.kind),
    ["init", "segment"]
  );
  assert.equal(rest, whole.length);
  assert.equal(units[0].bytes.length + units[1].bytes.length, whole.length);
});

test("buffered ranges merge near-touching segments and intersect across tracks", () => {
  const video = mp4.merged([
    { start: 4, end: 8 },
    { start: 0, end: 4 },
    { start: 8.1, end: 12 },
    { start: 20, end: 24 },
  ]);
  assert.deepEqual(video, [
    [0, 12],
    [20, 24],
  ]);
  assert.deepEqual(mp4.intersect(video, [[2, 22]]), [
    [2, 12],
    [20, 22],
  ]);
});
