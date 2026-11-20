import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const { TintedImage, tintedImageKey } = await import("./TintedImage.tsx");

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

test("an Image is tinted only through TintedImage, so a tint that changes reaches the screen", () => {
  const offenders = [];
  for (const file of ROOTS.flatMap((root) => sources(root))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/<Image\b[\s\S]*?\/>/g)) {
      if (/tintColor/.test(match[0])) offenders.push(`${relative(REPO, file)}:${text.slice(0, match.index).split("\n").length}`);
    }
  }
  assert.deepEqual(offenders, [], "react-native-macos applies an Image's tintColor only when its image loads; use TintedImage, which remounts it when the tint changes");
});

test("TintedImage gives the image a new identity for each tint and keeps the tint in its style", () => {
  const rest = TintedImage({ source: 1, tint: "#888888", style: { width: 11 } });
  const hovered = TintedImage({ source: 1, tint: "#ffffff", style: { width: 11 } });
  assert.notEqual(rest.key, hovered.key);
  assert.equal(rest.key, tintedImageKey("#888888"));
  assert.deepEqual(Object.assign({}, ...[rest.props.style].flat(Infinity).filter(Boolean)), { width: 11, tintColor: "#888888" });
  const plain = TintedImage({ source: 1, tint: undefined, identity: "a.png" });
  assert.equal(plain.key, tintedImageKey(undefined, "a.png"));
  assert.ok(!("tintColor" in Object.assign({}, ...[plain.props.style].flat(Infinity).filter(Boolean))));
});
