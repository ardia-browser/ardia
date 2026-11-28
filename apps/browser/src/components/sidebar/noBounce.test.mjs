import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const here = new URL("./", import.meta.url);

function openingTags(source) {
  const tags = [];
  const start = /(?<=[\s(])<(?:Animated\.)?ScrollView(?=\s)/g;
  for (let match = start.exec(source); match; match = start.exec(source)) {
    let depth = 0;
    let end = match.index;
    for (let i = match.index; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) {
        end = i;
        break;
      }
    }
    tags.push(source.slice(match.index, end + 1));
  }
  return tags;
}

test("every vertical list in the sidebar stops at its ends instead of rubber-banding", () => {
  const files = readdirSync(here).filter((name) => name.endsWith(".tsx"));
  const vertical = files.flatMap((name) =>
    openingTags(readFileSync(new URL(name, here), "utf8"))
      .filter((tag) => !/\bhorizontal\b/.test(tag))
      .map((tag) => ({ name, tag })),
  );
  assert.ok(vertical.length >= 3, `found ${vertical.length} vertical scroll views`);
  for (const { name, tag } of vertical) assert.match(tag, /alwaysBounceVertical=\{false\}/, `${name}: ${tag.split("\n")[0]}`);
});
