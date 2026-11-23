import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const components = new URL("../", import.meta.url);
const source = (name) => readFileSync(new URL(name, components), "utf8");
const ROLE = /accessibilityRole|radioA11y|checkboxA11y|switchA11y/;
const TAP = /onAccessibilityTap/;
const DEFINITION_REACH = 900;

function pressables(text) {
  const tags = [];
  for (const match of text.matchAll(/<Pressable\b/g)) {
    let depth = 0;
    let end = match.index + match[0].length;
    for (; end < text.length; end++) {
      const c = text[end];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0 && text[end - 1] !== "=") break;
    }
    tags.push({ line: text.slice(0, match.index).split("\n").length, tag: text.slice(match.index, end + 1) });
  }
  return tags;
}

function spreadDefinitions(text, tag) {
  return [...tag.matchAll(/\{\.\.\.([A-Za-z_]\w*)\}/g)]
    .flatMap(([, name]) => [...text.matchAll(new RegExp(`\\bconst ${name}\\b[^=]*=`, "g"))].map((m) => text.slice(m.index + m[0].length, m.index + m[0].length + DEFINITION_REACH)))
    .join("\n");
}

test("every pressable that announces a button, radio, checkbox or switch has the native accessibility press", () => {
  const files = readdirSync(components, { recursive: true }).map((name) => name.replaceAll("\\", "/")).filter((name) => /\.tsx$/.test(name) && !name.includes("fixtures"));
  const missing = files.flatMap((file) => {
    const text = source(file);
    return pressables(text)
      .filter(({ tag }) => {
        const spread = spreadDefinitions(text, tag);
        return (ROLE.test(tag) || ROLE.test(spread)) && !(TAP.test(tag) || TAP.test(spread));
      })
      .map(({ line }) => `${file}:${line}`);
  });
  assert.deepEqual(missing, [], "a control with a role passes onAccessibilityTap={tapActivates(press)} (ui/a11y), dropped while disabled or closing");
});

test("the shared checkbox offers the native press in both interactive looks and not on a drawing-only ring", () => {
  const text = source("ui/Checkbox.tsx");
  assert.match(text, /onAccessibilityTap: active \? tapActivates\(live\(toggle\)\) : undefined/);
  assert.match(text, /if \(look === "ring" && !onChange\) return <RingCheck/);
});
