import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { switcherFit, SWITCHER_INK } = await import("./switcherInk.ts");
const { profileSwitcher } = await import("./tokens.ts");

const picker = readFileSync(new URL("./ProfileIcons.tsx", import.meta.url), "utf8");
const names = [...picker.matchAll(/\{ name: "([^"]+)", title:/g)].map((m) => m[1]);

const inkWidth = (name) => SWITCHER_INK[name][0] * switcherFit(name).scale;
const inkHeight = (name) => SWITCHER_INK[name][1] * switcherFit(name).scale;
const spread = (values) => Math.max(...values) - Math.min(...values);

test("every symbol in the picker has a measured ink box and the table lists nothing else", () => {
  assert.equal(names.length, 45);
  assert.deepEqual(Object.keys(SWITCHER_INK).sort(), [...names].sort());
});

test("each symbol is scaled until its ink fills the same box", () => {
  for (const name of names) {
    const width = inkWidth(name);
    const height = inkHeight(name);
    assert.ok(width <= profileSwitcher.ink + 1e-9 && height <= profileSwitcher.ink + 1e-9, `${name} ink ${width} x ${height} overflows the box`);
    assert.ok(Math.max(width, height) > profileSwitcher.ink - 1e-9, `${name} ink ${width} x ${height} does not fill the box`);
  }
});

test("ink widths across the picker are far closer than the raw 7 to 20 pt", () => {
  const raw = spread(names.map((name) => SWITCHER_INK[name][0]));
  const fitted = spread(names.map(inkWidth));
  assert.ok(raw > 13, `raw spread ${raw}`);
  assert.ok(fitted < raw / 2, `fitted spread ${fitted}`);
});

test("the widest symbols shrink and the narrowest grow", () => {
  assert.ok(switcherFit("bicycle").scale < 0.75);
  assert.ok(switcherFit("mountain.2.fill").scale < 0.7);
  assert.ok(switcherFit("music.note").scale > 1.1);
});

test("the offset moves the ink centre onto the centre of the cell", () => {
  for (const name of names) {
    const fit = switcherFit(name);
    const [, , centreX, centreY] = SWITCHER_INK[name];
    assert.ok(Math.abs(centreX * fit.scale + fit.dx) < 1e-9, `${name} x`);
    assert.ok(Math.abs(centreY * fit.scale + fit.dy) < 1e-9, `${name} y`);
  }
});

test("the gaps in a house, briefcase and music note row are closer than before", () => {
  const row = ["house.fill", "briefcase.fill", "music.note"];
  const cell = profileSwitcher.iconCell;
  const gaps = (width) => [0, 1].map((i) => cell - (width(row[i]) + width(row[i + 1])) / 2);
  const before = spread(gaps((name) => SWITCHER_INK[name][0]));
  const after = spread(gaps(inkWidth));
  assert.ok(after < before, `${after} is not below ${before}`);
});

test("a symbol with no measurement and an emoji are drawn as they were", () => {
  assert.deepEqual(switcherFit("not.a.symbol"), { scale: 1, dx: 0, dy: 0 });
  assert.deepEqual(switcherFit("🙂"), { scale: 1, dx: 0, dy: 0 });
});

test("a symbol named like a property every object inherits is unmeasured, not a crash", () => {
  for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
    assert.deepEqual(switcherFit(name), { scale: 1, dx: 0, dy: 0 }, name);
  }
});
