import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { useBrowser } = await import("../../state/browser/store.ts");
const { setLive } = await import("../../state/tabs/tabLive.ts");
const { watchLastingLoad } = await import("../../state/tabs/lastingLoad.ts");
const { fieldLoadColor } = await import("./fieldLoadColor.ts");
const { PROFILE_COLORS, themeFor } = await import("../ui/theme.ts");

test("the load glow uses preset and custom profile colors, not the generic accent", () => {
  for (const name of ["blue", "red", "neutral"]) {
    assert.equal(fieldLoadColor(themeFor(`${name}:light`)), PROFILE_COLORS[name].swatch);
  }
  const theme = themeFor("incognito:dark");
  assert.equal(fieldLoadColor(theme), theme.accent);
  assert.equal(fieldLoadColor({ ...theme, custom: {}, powerUpColor: "#D36A51" }), "#D36A51");
});

const S = () => useBrowser.getState();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
const w = S().createWindow({ url: "https://a.example/" });
const tab = S().windows[w].tabIds[0];

test("a load that lasts past 150 ms is reported once when it starts lasting and once when it ends", async () => {
  const seen = [];
  const stop = watchLastingLoad(tab, (lasting) => seen.push(lasting));
  setLive(tab, { isLoading: true });
  await sleep(60);
  assert.deepEqual(seen, []);
  await sleep(150);
  assert.deepEqual(seen, [true]);
  setLive(tab, { isLoading: false });
  assert.deepEqual(seen, [true, false]);
  stop();
});

test("a load shorter than 150 ms is never reported", async () => {
  const seen = [];
  const stop = watchLastingLoad(tab, (lasting) => seen.push(lasting));
  setLive(tab, { isLoading: true });
  await sleep(40);
  setLive(tab, { isLoading: false });
  await sleep(200);
  assert.deepEqual(seen, []);
  stop();
});

test("the field's loading glow mounts once per field and runs a load without React renders", () => {
  const fill = readFileSync(new URL("./FieldLoadFill.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(fill, /useLastingLoad|usePageProgress|setMounted/);
  for (const file of ["./Toolbar.tsx", "../littleArdia/SmallChrome.tsx"]) assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /<FieldLoadFill key=/);
});

test("without the native glow (an older build, Linux, Windows) the field keeps the JavaScript fill", async () => {
  const { FieldLoadFill } = await import("./FieldLoadFill.tsx");
  const { FieldGlowFill } = await import("./FieldGlowFill.tsx");
  assert.notEqual(FieldLoadFill, FieldGlowFill);
  assert.match(String(FieldLoadFill.type), /JsFieldLoadFill/);
});

test("the rim uses the field radius and cannot overlap itself on narrow fields", async () => {
  const { fieldRimRadius } = await import("./FieldLoadFill.tsx");
  assert.equal(fieldRimRadius(320, 30, 8), 8);
  assert.equal(fieldRimRadius(160, 34, 10), 10);
  assert.equal(fieldRimRadius(18, 30, 12), 9);
  assert.equal(fieldRimRadius(100, 22, 14), 11);
  assert.equal(fieldRimRadius(100, 22, 0), 0);
});
