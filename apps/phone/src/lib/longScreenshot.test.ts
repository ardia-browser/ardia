import assert from "node:assert/strict";
import { test } from "node:test";
import { HOSTILE_VALUES } from "../../../../scripts/security/hostile-inputs.mjs";
import { draggedCrop, isWholeCrop, minimumCropRows, savedShotOf, shotLabel, shotOf, wholeCrop, type Shot } from "./longScreenshot.ts";

const ID = "0f8e2d4c-6b1a-4c3e-9a7d-2b5e8f1c3a90";
const dir = `file:///data/user/0/com.ardia.browser.android/cache/long-screenshots/${ID}`;
const native = {
  id: ID,
  uri: `${dir}/shot.png`,
  path: `/data/user/0/com.ardia.browser.android/cache/long-screenshots/${ID}/shot.png`,
  width: 1080,
  height: 5000,
  screens: 3,
  complete: true,
  tiles: [
    { uri: `${dir}/tile-0.jpg`, top: 0, height: 2048 },
    { uri: `${dir}/tile-1.jpg`, top: 2048, height: 2048 },
    { uri: `${dir}/tile-2.jpg`, top: 4096, height: 904 },
  ],
};

const shot = shotOf(native)!;

test("a capture from the module becomes a shot whose tiles cover it top to bottom", () => {
  assert.deepEqual(shot, { id: ID, uri: native.uri, width: 1080, height: 5000, screens: 3, complete: true, tiles: native.tiles });
});

test("a capture that is malformed in any field is refused whole", () => {
  const broken: unknown[] = [
    null,
    "shot",
    [],
    { ...native, id: "../../files" },
    { ...native, uri: "https://example.com/shot.png" },
    { ...native, uri: "file:///cache/shot.png?x" },
    { ...native, width: Number.NaN },
    { ...native, height: -5000 },
    { ...native, height: 4.5 },
    { ...native, screens: 21 },
    { ...native, screens: 0 },
    { ...native, tiles: [] },
    { ...native, tiles: "tiles" },
    { ...native, tiles: native.tiles.slice(1) },
    { ...native, tiles: [native.tiles[0], native.tiles[2]] },
    { ...native, tiles: [...native.tiles, { uri: `${dir}/tile-3.jpg`, top: 5000, height: 10 }] },
    { ...native, tiles: [{ ...native.tiles[0], uri: "javascript:alert(1)" }, native.tiles[1], native.tiles[2]] },
    { ...native, width: Number.POSITIVE_INFINITY },
    { ...native, complete: "yes" },
    { ...native, complete: undefined },
  ];
  for (const raw of broken) assert.equal(shotOf(raw), null, JSON.stringify(raw));
});

test("a saved picture is taken only as a media store address with its size", () => {
  assert.deepEqual(savedShotOf({ uri: "content://media/external_primary/images/media/42", width: 1080, height: 4000 }), { uri: "content://media/external_primary/images/media/42", width: 1080, height: 4000 });
  for (const uri of ["file:///sdcard/a.png", "content://com.evil/42", "content://media/x?y", 42]) assert.equal(savedShotOf({ uri, width: 1, height: 1 }), null);
  assert.equal(savedShotOf({ uri: "content://media/external_primary/images/media/42", width: 0, height: 1 }), null);
});

test("dragging the top handle moves only the top, in image rows, and never past the bottom", () => {
  const scale = 0.5;
  const least = minimumCropRows(shot, scale, 48);
  assert.equal(least, 96);
  assert.deepEqual(draggedCrop(shot, wholeCrop(shot), "top", 100, scale, least), { top: 200, bottom: 5000 });
  assert.deepEqual(draggedCrop(shot, wholeCrop(shot), "top", -100, scale, least), { top: 0, bottom: 5000 });
  assert.deepEqual(draggedCrop(shot, { top: 0, bottom: 1000 }, "top", 9000, scale, least), { top: 904, bottom: 1000 });
});

test("dragging the bottom handle moves only the bottom and never above the top", () => {
  const scale = 0.5;
  const least = minimumCropRows(shot, scale, 48);
  assert.deepEqual(draggedCrop(shot, wholeCrop(shot), "bottom", -500, scale, least), { top: 0, bottom: 4000 });
  assert.deepEqual(draggedCrop(shot, wholeCrop(shot), "bottom", 500, scale, least), { top: 0, bottom: 5000 });
  assert.deepEqual(draggedCrop(shot, { top: 3000, bottom: 5000 }, "bottom", -9000, scale, least), { top: 3000, bottom: 3096 });
});

test("a broken scale or move leaves the crop where it was", () => {
  const start = { top: 100, bottom: 4000 };
  for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.deepEqual(draggedCrop(shot, start, "top", 0, scale, 1), start);
  assert.deepEqual(draggedCrop(shot, start, "bottom", Number.NaN, 0.5, 1), start);
});

test("only a crop that keeps every row counts as whole", () => {
  assert.ok(isWholeCrop(shot, wholeCrop(shot)));
  assert.ok(!isWholeCrop(shot, { top: 1, bottom: 5000 }));
  assert.ok(!isWholeCrop(shot, { top: 0, bottom: 4999 }));
});

test("a shot shorter than the least crop can still be saved whole", () => {
  const tiny: Shot = { ...shot, height: 40, tiles: [{ uri: `${dir}/tile-0.jpg`, top: 0, height: 40 }] };
  assert.equal(minimumCropRows(tiny, 0.5, 48), 40);
  assert.deepEqual(draggedCrop(tiny, wholeCrop(tiny), "top", 30, 0.5, 40), { top: 0, bottom: 40 });
});

test("tiles must be this capture's own numbered files, each once, so no other file reaches Image or repeats a key", () => {
  const other = "1b2c3d4e-0000-4000-8000-000000000000";
  const otherDir = `file:///data/user/0/com.ardia.browser.android/cache/long-screenshots/${other}`;
  const tiles = (uris: string[]) => uris.map((uri, index) => ({ uri, top: index * 2048, height: index === 2 ? 904 : 2048 }));
  const refused = [
    tiles([`${dir}/tile-0.jpg`, `${dir}/tile-0.jpg`, `${dir}/tile-2.jpg`]),
    tiles([`${dir}/tile-0.jpg`, `${otherDir}/tile-1.jpg`, `${dir}/tile-2.jpg`]),
    tiles([`${dir}/tile-0.jpg`, `${dir}/../tile-1.jpg`, `${dir}/tile-2.jpg`]),
    tiles([`${dir}/tile-0.jpg`, "file:///sdcard/DCIM/private.jpg", `${dir}/tile-2.jpg`]),
    tiles([`${dir}/tile-0.jpg`, `${dir}/tile-2.jpg`, `${dir}/tile-1.jpg`]),
  ];
  for (const raw of refused) assert.equal(shotOf({ ...native, tiles: raw }), null, JSON.stringify(raw));
  assert.equal(shotOf({ ...native, uri: `${otherDir}/shot.png` }), null, "the picture of another capture");
  assert.equal(shotOf({ ...native, uri: "file:///sdcard/Download/shot.png" }), null, "a picture outside the capture cache");
  assert.equal(shotOf({ ...native, uri: `file:///data/user/0/com.ardia.browser.android/files/long-screenshots/${ID}/shot.png` }), null, "outside the cache");
});

test("the shared hostile list never reaches Image: every field of the capture refuses each value, at the sink the tiles feed", () => {
  assert.notEqual(shotOf(native), null, "positive control");
  const fields = ["id", "uri", "width", "height", "screens", "complete", "tiles"] as const;
  for (const { id, value } of HOSTILE_VALUES) {
    for (const field of fields) {
      const tileUris = shotOf({ ...native, [field]: value })?.tiles.map((tile) => tile.uri) ?? [];
      assert.ok(tileUris.every((uri) => native.tiles.some((tile) => tile.uri === uri)), `${field} ${id}`);
      if (field !== "complete" || typeof value !== "boolean") assert.equal(shotOf({ ...native, [field]: value }), null, `${field} ${id}`);
    }
    for (const key of ["uri", "top", "height"] as const) {
      const tiles = native.tiles.map((tile, index) => (index === 1 ? { ...tile, [key]: value } : tile));
      assert.equal(shotOf({ ...native, tiles }), null, `tile ${key} ${id}`);
    }
    if (typeof value === "string" && value !== "") {
      assert.equal(shotOf({ ...native, uri: `${dir}/shot.png${value}` }), null, `uri suffix ${id}`);
      const tiles = native.tiles.map((tile, index) => (index === 1 ? { ...tile, uri: `${dir}/tile-1.jpg${value}` } : tile));
      assert.equal(shotOf({ ...native, tiles }), null, `tile suffix ${id}`);
    }
    assert.equal(savedShotOf({ uri: value, width: 1080, height: 10 }), null, `saved uri ${id}`);
  }
});

test("a capture that stopped early says so with its screen count", () => {
  assert.equal(shotLabel(shot), "3 screens");
  assert.equal(shotLabel({ ...shot, screens: 1 }), "1 screen");
  assert.equal(shotLabel({ ...shot, complete: false }), "Stopped after 3 screens");
  assert.equal(shotLabel({ ...shot, screens: 1, complete: false }), "Stopped after 1 screen");
});
