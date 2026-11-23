import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const { tintedImage, tintedImageKey } = await import("./TintedImage.tsx");

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const ROOTS = [SRC, join(REPO, "packages"), join(REPO, "apps/linux/src")];

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx$/.test(name) && !name.startsWith("TintedImage.")) out.push(path);
  }
  return out;
}

test("an Image is tinted only through tintedImage, so a tint that changes reaches the screen", () => {
  const offenders = [];
  for (const file of ROOTS.flatMap((root) => sources(root))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/<Image\b[\s\S]*?\/>/g)) {
      if (/tintColor/.test(match[0])) offenders.push(`${relative(REPO, file)}:${text.slice(0, match.index).split("\n").length}`);
    }
  }
  assert.deepEqual(offenders, [], "react-native-macos applies an Image's tintColor only when its image loads; use tintedImage, which remounts it when the tint changes");
});

test("tintedImage gives the image a new identity for each tint and keeps the tint in its style", () => {
  const rest = tintedImage({ source: 1, tint: "#888888", style: { width: 11 } });
  const hovered = tintedImage({ source: 1, tint: "#ffffff", style: { width: 11 } });
  assert.notEqual(rest.key, hovered.key);
  assert.equal(rest.key, tintedImageKey("#888888"));
  assert.deepEqual(Object.assign({}, ...[rest.props.style].flat(Infinity).filter(Boolean)), { width: 11, tintColor: "#888888" });
  const plain = tintedImage({ source: 1, tint: undefined, identity: "a.png" });
  assert.equal(plain.key, tintedImageKey(undefined, "a.png"));
  assert.ok(!("tintColor" in Object.assign({}, ...[plain.props.style].flat(Infinity).filter(Boolean))));
});

test("tintedImage adds no component of its own: it returns the Image, so a favicon costs one mount, not two", async () => {
  const { Image } = await import("react-native");
  assert.equal(tintedImage({ source: 1, tint: "#888888" }).type, Image);
});

test("only macOS swaps the image for a new tint; Windows and Linux redraw the one they have", () => {
  const read = (name) => readFileSync(new URL(`../../lib/${name}`, import.meta.url), "utf8");
  assert.match(read("platformFeatures.ts"), /\btintNeedsNewImage:\s*true\b/);
  for (const name of ["platformFeatures.linux.ts", "platformFeatures.windows.ts"]) assert.match(read(name), /\btintNeedsNewImage:\s*false\b/);
});
