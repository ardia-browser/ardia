import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
globalThis.require ??= (id) => ({ asset: id });
const { drawnSymbol } = await import("./Symbol.tsx");
const { drawnFadeLabel } = await import("./FadeLabel.tsx");

test("a drawn symbol is the native view with the look's icon name and a hex colour, as the Symbol component draws it", () => {
  const drawn = drawnSymbol({ name: "globe", size: 14, color: "rgba(255,255,255,0.5)", style: { width: 16 } });
  assert.equal(drawn.props.size, 14);
  assert.match(String(drawn.props.color), /^#/);
  assert.deepEqual(drawn.props.style, { width: 16 });
});

test("a drawn fade label scales its fade in the sidebar and keeps every other prop", () => {
  const outside = drawnFadeLabel({ text: "a\u2028b", fontSize: 13, color: "#fff" }, false);
  const inside = drawnFadeLabel({ text: "a\u2028b", fontSize: 13, color: "#fff" }, true);
  assert.equal(outside.props.fontSize, 13);
  assert.equal(outside.props.color, "#fff");
  assert.doesNotMatch(outside.props.text, /\u2028/, "titles draw on one line");
  assert.equal(outside.props.fadeWidth, 24);
  assert.equal(typeof inside.props.fadeWidth, "number");
  assert.equal(outside.props.weight, inside.props.weight);
});

test("every sidebar row's label and every no-favicon globe draw the native view directly, one component each instead of two", () => {
  const row = readFileSync(new URL("../sidebar/SidebarRow.tsx", import.meta.url), "utf8");
  const favicon = readFileSync(new URL("../favicon/Favicon.tsx", import.meta.url), "utf8");
  const label = row.slice(row.indexOf("export const SidebarRowLabel"), row.indexOf("const SLEEPING_TITLE"));
  assert.match(label, /return drawnFadeLabel\(/);
  assert.doesNotMatch(label, /<FadeLabel/);
  assert.match(favicon, /if \(!initial\) return drawnSymbol\(\{ name: "globe"/);
});
