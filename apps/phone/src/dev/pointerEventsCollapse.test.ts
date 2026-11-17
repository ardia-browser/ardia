import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const SRC = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".tsx") && !name.includes(".test.") ? [path] : [];
  });
}

export function openingTags(source: string): string[] {
  const tags: string[] = [];
  for (const start of source.matchAll(/<[A-Z][\w.]*\b/g)) {
    let depth = 0;
    let at = start.index! + start[0].length;
    for (; at < source.length; at++) {
      const char = source[at];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0 && source[at - 1] !== "=") break;
    }
    tags.push(source.slice(start.index!, at + 1));
  }
  return tags;
}

export function togglesTouchesOff(tag: string): boolean {
  const value = /\bpointerEvents=\{([^}]*)\}/.exec(tag)?.[1];
  return value !== undefined && value.includes('"none"') && value.includes("?");
}

test("a container whose touches switch off is a real view in both states, so the switch never makes a new host view and remounts what it holds mid-motion", () => {
  const offenders = sources(SRC).flatMap((file) =>
    openingTags(readFileSync(file, "utf8"))
      .filter((tag) => togglesTouchesOff(tag) && !/\bcollapsable=\{false\}/.test(tag))
      .map((tag) => `${relative(SRC, file)}: ${tag.split("\n")[0]!.trim()}`),
  );
  assert.deepEqual(offenders, []);
});

test("a container whose touches switch off also leaves the accessibility tree while they are off, on both phones, so a real view left over the screen never hides what is under it from a screen reader", () => {
  const offenders = sources(SRC).flatMap((file) =>
    openingTags(readFileSync(file, "utf8"))
      .filter((tag) => togglesTouchesOff(tag) && !(/\baccessibilityElementsHidden=\{/.test(tag) && /\bimportantForAccessibility=\{/.test(tag)))
      .map((tag) => `${relative(SRC, file)}: ${tag.split("\n")[0]!.trim()}`),
  );
  assert.deepEqual(offenders, []);
});

test("the check reads whole opening tags across lines and sees a switched pointerEvents", () => {
  const [tag] = openingTags('<View\n  style={a}\n  pointerEvents={on ? "box-none" : "none"}\n  collapsable={false}\n>\n  <Text />\n</View>');
  assert.ok(tag!.includes("collapsable={false}"));
  assert.equal(togglesTouchesOff(tag!), true);
  assert.equal(togglesTouchesOff('<View pointerEvents="none">'), false);
});
