import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scaledAsset, scaledAssetModule, scaledAssets } from "../scaledAssets.ts";
import { HOST_COMPONENT_LIMIT, HOST_PATH_LIMIT, hostSafeFileName, hostServesPath, SANITIZED_NAME_LIMIT, SANITIZED_PATH_LIMIT } from "../desktopPaths.ts";
import { normalizePath } from "vite";
import { alphaDrift, BROWSER_ASSETS, bundledImages, hiDpiBrowserPngs, PIXEL_SCALES, pngSize, scaledBrowserAssets } from "./scaledAssetsBundle.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const asset = (name) => join(BROWSER_ASSETS, name);

test("every @2x and @3x PNG in apps/browser/assets is reachable from its 1x name", () => {
  const hiDpi = hiDpiBrowserPngs();
  assert.equal(hiDpi.length, 46);
  const reached = new Set(scaledBrowserAssets().map((entry) => entry.file));
  for (const file of hiDpi) {
    const base = file.replace(/@\d+x\.png$/, ".png");
    assert.ok(existsSync(base), `${file} has no 1x twin`);
    const best = PIXEL_SCALES.map((scale) => base.replace(/\.png$/, `@${scale}x.png`)).find((sibling) => existsSync(sibling));
    assert.equal(scaledAsset(base)?.file, best);
    if (file === best) assert.ok(reached.has(file));
  }
  assert.equal(reached.size, 38);
});

test("the resolver picks the sharpest sibling and keeps the 1x logical size", () => {
  assert.deepEqual(scaledAsset(asset("ntp-mark-sun.png")), { file: asset("ntp-mark-sun@2x.png"), scale: 2, width: 100, height: 100 });
  assert.deepEqual(scaledAsset(asset("tidy-broom.png")), { file: asset("tidy-broom@3x.png"), scale: 3, width: 11, height: 11 });
  assert.deepEqual(scaledAsset(asset("developer-bar/console.png")), { file: asset("developer-bar/console@3x.png"), scale: 3, width: 15, height: 15 });
  assert.deepEqual(scaledAsset(asset("dev-stripes-dark-ink.png")), { file: asset("dev-stripes-dark-ink@2x.png"), scale: 2, width: 28, height: 28 });
  for (const entry of scaledBrowserAssets()) {
    const pixels = pngSize(entry.file);
    assert.deepEqual(pixels, { width: entry.width * entry.scale, height: entry.height * entry.scale }, `${entry.file} is not ${entry.scale}x its 1x twin`);
  }
});

test("every 1x PNG draws the same shape as its Retina sibling, so 1x screens see no cropped or shifted art", () => {
  for (const entry of scaledBrowserAssets()) {
    const drift = alphaDrift(entry.base, entry.file, entry.scale);
    assert.ok(drift <= 8, `${entry.base} differs from ${entry.scale}x its sibling by ${drift.toFixed(1)} alpha per pixel`);
  }
});

test("assets without a Retina sibling, and the siblings themselves, resolve as they are", () => {
  for (const name of ["app-icon.png", "site-icons/github.png", "browsers/arc.png", "tidy-broom@3x.png", "ntp-mark-sun@2x.png", "missing.png"]) {
    assert.equal(scaledAsset(asset(name)), null, name);
  }
  assert.equal(scaledAsset(join(BROWSER_ASSETS, "onboarding")), null);
});

test("a scaled asset module exports a React Native image source with 1x points", () => {
  const module = scaledAssetModule({ file: "/a/tidy-broom@3x.png", scale: 3, width: 11, height: 11 });
  assert.equal(module, 'import uri from "/a/tidy-broom@3x.png";\nexport default { uri, width: 11, height: 11, scale: 3 };');
});

test("in dev, a Retina sibling added or removed later reloads the image that already resolved to the old file", async (t) => {
  const folder = normalizePath(mkdtempSync(join(tmpdir(), "ardia-scaled-")));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const base = `${folder}/mark.png`;
  copyFileSync(asset("tidy-broom.png"), base);
  const watcher = new EventEmitter();
  const watchedFolders = [];
  watcher.add = (path) => watchedFolders.push(normalizePath(path));
  const importer = { id: "/src/App.tsx", importers: new Set() };
  const plain = { id: base, importers: new Set([importer]) };
  const invalidated = [];
  const sent = [];
  const plugin = scaledAssets("test:scaled");
  plugin.configureServer({
    watcher,
    moduleGraph: {
      getModuleById: () => undefined,
      getModulesByFile: (file) => (file === base ? new Set([plain]) : undefined),
      invalidateModule: (mod) => invalidated.push(mod.id),
    },
    ws: { send: (message) => sent.push(message.type) },
  });
  const context = { resolve: async (source) => ({ id: source }) };
  assert.equal(await plugin.resolveId.call(context, base, "/src/App.tsx", {}), null);
  assert.deepEqual(watchedFolders, [folder]);
  copyFileSync(asset("tidy-broom@2x.png"), `${folder}/mark@2x.png`);
  watcher.emit("add", `${folder}/mark@2x.png`);
  assert.deepEqual(invalidated.sort(), [base, "/src/App.tsx"].sort());
  assert.deepEqual(sent, ["full-reload"]);
  assert.equal(await plugin.resolveId.call(context, base, "/src/App.tsx", {}), `\0ardia-scaled:${base}`);
  watcher.emit("add", `${folder}/other.png`);
  assert.deepEqual(sent, ["full-reload"], "a plain PNG reloads nothing");
  assert.deepEqual(watchedFolders, [folder], "each folder is watched once");
  rmSync(`${folder}/mark@2x.png`);
  watcher.emit("unlink", `${folder}/mark@2x.png`);
  assert.deepEqual(sent, ["full-reload", "full-reload"]);
  assert.equal(await plugin.resolveId.call(context, base, "/src/App.tsx", {}), null);
});

test("emitted names follow the strictest WebUI host rules, so mark@2x ships as mark-2x and nothing can 404", () => {
  assert.equal(hostSafeFileName("assets/ntp-mark-front@2x"), "assets/ntp-mark-front-2x");
  assert.equal(hostSafeFileName("assets/a b+c~d"), "assets/a-b-c-d");
  assert.equal(hostSafeFileName("assets/..evil..name"), "assets/.evil.name");
  assert.equal(hostSafeFileName("assets/../x"), "assets/-/x");
  assert.equal(hostSafeFileName("a//b"), "a/-/b");
  const long = hostSafeFileName(`assets/${"n".repeat(300)}.png`);
  assert.equal(long.split("/")[1].length, SANITIZED_NAME_LIMIT);
  assert.ok(long.endsWith(".png"));
  assert.ok(SANITIZED_NAME_LIMIT + 32 <= HOST_COMPONENT_LIMIT, "a hash and extension still fit after truncation");
  for (const name of ["assets/ntp-mark-front@3x-Ab_9.png", "assets/../x.png", "../x.png", "assets/./x.png", ".", `assets/${"n".repeat(129)}.png`, "assets//x.png"]) {
    assert.equal(hostServesPath(name), false, name);
    assert.ok(hostServesPath(hostSafeFileName(name)), `${name} sanitizes to a served path`);
  }
  assert.equal(hostServesPath("/assets/x.png"), false);
  assert.equal(hostServesPath(`${"a/".repeat(300)}x`), false, "the whole path stays within the Mac host's 512 bytes");
  assert.ok(hostServesPath("assets/ntp-mark-front-2x-Ab_9.png"));
  assert.equal(hostSafeFileName("a./b../c.png"), "a/b/c.png", "no part ends in a dot");
  assert.equal(hostSafeFileName("assets/CON.png"), "assets/-CON.png");
  assert.equal(hostSafeFileName("nul/com1/LPT9.txt/aux"), "-nul/-com1/-LPT9.txt/-aux");
  assert.equal(hostSafeFileName("console/com10/comma.png"), "console/com10/comma.png", "only the exact device names are reserved");
  const dotted = hostSafeFileName(`${"n".repeat(91)}.${"n".repeat(20)}.png`);
  assert.equal(dotted, `${"n".repeat(91)}.png`, "a cut that ends on a dot never meets the extension as '..'");
  assert.ok(hostServesPath(dotted));
  const nested = hostSafeFileName(Array.from({ length: 6 }, (_, i) => `${i}${"d".repeat(95)}`).concat("mark.png").join("/"));
  assert.ok(nested.length <= SANITIZED_PATH_LIMIT, "deep names keep room for the prefix and hash");
  assert.ok(nested.endsWith("/mark.png"));
  assert.ok(hostServesPath(`assets/${nested}-Ab_9xyz1.png`) && `assets/${nested}-Ab_9xyz1.png`.length <= HOST_PATH_LIMIT);
});
for (const mode of ["mac", "linux", "win"]) {
  test(`the ${mode} build bundles the Retina siblings instead of the 1x PNGs`, { timeout: 120_000 }, async () => {
    const { holds, fileNames } = await bundledImages(root, { mode });
    const refused = fileNames.filter((name) => !hostServesPath(name));
    assert.deepEqual(refused, [], `chrome://ardia/ refuses these ${mode} files, so they would 404`);
    assert.ok(fileNames.some((name) => /-2x-/.test(name)), `a Retina sibling ships in the ${mode} build under a host-safe name`);
    for (const entry of scaledBrowserAssets()) {
      assert.ok(holds(entry.file), `${entry.file} is missing from the ${mode} build`);
      assert.ok(!holds(entry.base), `${entry.base} still ships in the ${mode} build`);
    }
  });
}
