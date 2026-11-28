import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
globalThis.require ??= (id) => ({ asset: id });
const { drawnSymbol } = await import("./Symbol.tsx");
const { drawnFadeLabel } = await import("./FadeLabel.tsx");
const { contrastTheme, themeFor } = await import("./theme.ts");

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

test("a drawn fade label hands the native view a hex colour with higher contrast text, in dark and light", () => {
  for (const mode of ["dark", "light"]) {
    const theme = contrastTheme(themeFor(`plum:${mode}`));
    for (const role of ["textTab", "textSecondary", "textTertiary", "placeholder"]) {
      const drawn = drawnFadeLabel({ text: "Themes_Copy01", fontSize: 13, color: theme[role] }, true);
      assert.match(String(drawn.props.color), /^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/i, `${mode} ${role}`);
    }
  }
});

test("every sidebar row's label and every no-favicon globe draw the native view directly, one component each instead of two", () => {
  const row = readFileSync(new URL("../sidebar/SidebarRow.tsx", import.meta.url), "utf8");
  const favicon = readFileSync(new URL("../favicon/Favicon.tsx", import.meta.url), "utf8");
  const label = row.slice(row.indexOf("export const SidebarRowLabel"), row.indexOf("const SLEEPING_TITLE"));
  assert.match(label, /return drawnFadeLabel\(/);
  assert.doesNotMatch(label, /<FadeLabel/);
  assert.match(favicon, /if \(!initial\) return drawnSymbol\(\{ name: "globe"/);
});

test("the sidebar divider's Clear arrow draws the native view inside a button that re-renders on every theme change", () => {
  const divider = readFileSync(new URL("../sidebar/ClearDivider.tsx", import.meta.url), "utf8");
  assert.match(divider, /icon=\{\(color\) => drawnSymbol\(\{ name: "arrow\.down", size: 9, weight: "semibold", color, style: CLEAR_ARROW \}\)\}/);
  assert.doesNotMatch(divider, /<Symbol\b/);
  const button = divider.slice(divider.indexOf("function DividerButton"));
  assert.match(button, /const theme = useTheme\(\);/);
});

test("the new-tab row's plus draws the native view inside a row that re-renders on every theme change", () => {
  const row = readFileSync(new URL("../sidebar/NewTabRow.tsx", import.meta.url), "utf8");
  assert.match(row, /\{drawnSymbol\(\{ name: "plus", size: quiet \? sidebarPoints\(10\) : ROW_GLYPH\.plus, weight: "medium", color: quiet \? quietInk : tokens\.newTabIcon, style: \{ width: ROW_GLYPH\.box, height: ROW_GLYPH\.box \} \}\)\}/);
  assert.doesNotMatch(row, /<Symbol\b/);
  assert.match(row, /export const NewTabRow = memo\(function NewTabRow[^\n]*\n  const theme = useTheme\(\);/);
});
