import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

const { TextInput } = await import("./shims/react-native.tsx");
const render = (props) => renderToStaticMarkup(createElement(TextInput, { value: "", onChangeText: () => {}, ...props }));

test(`a field's cursorColor becomes its caret colour in the ${process.env.ARDIA_DESKTOP_MODE ?? "linux"} WebUI`, () => {
  const html = render({ cursorColor: "#787D86", style: { color: "#000000" } });
  assert.match(html, /caret-color:\s*(#787D86|rgba?\(120,\s*125,\s*134)/i, html);
  assert.match(html, /color:\s*(#000000|rgba?\(0,\s*0,\s*0)/i, "the field's own style is kept");
});

test("caretHidden still hides the caret when a cursorColor is set, and no cursorColor leaves the caret alone", () => {
  const hidden = render({ cursorColor: "#787D86", caretHidden: true });
  assert.match(hidden, /r-caretColor-/, `React Native Web's transparent caret class is kept: ${hidden}`);
  assert.doesNotMatch(hidden, /caret-color:/i, `no inline caret colour overrides it: ${hidden}`);
  assert.doesNotMatch(render({}), /caret-color/i);
  assert.doesNotMatch(render({ cursorColor: "#787D86" }), /cursorcolor/i, "the prop doesn't reach the DOM as an attribute");
});

test(`a field's selection colour and its text colour style its selection, light and dark apart, in the ${process.env.ARDIA_DESKTOP_MODE ?? "linux"} WebUI`, () => {
  const light = render({ selectionColor: "rgba(120,125,134,0.4)", style: { color: "#000000" } });
  const dark = render({ selectionColor: "rgba(120,125,134,0.7)", style: { color: "#FFFFFF" } });
  for (const [html, wash, ink] of [[light, "0.4", /--ardia-selection-fg:\s*(#000000|rgba?\(0,\s*0,\s*0)/i], [dark, "0.7", /--ardia-selection-fg:\s*(#FFFFFF|rgba?\(255,\s*255,\s*255)/i]]) {
    assert.match(html, /data-ardia-selection=""/, html);
    assert.match(html, new RegExp(`--ardia-selection-bg:\\s*rgba\\(120,\\s*125,\\s*134,\\s*${wash}\\)`), html);
    assert.match(html, ink, html);
  }
  assert.notEqual(light, dark);
  assert.doesNotMatch(render({}), /ardia-selection/, "a field without a selection colour keeps Chromium's");
  const css = readFileSync(new URL("./base.css", import.meta.url), "utf8");
  assert.match(css, /input\[data-ardia-selection\]::selection,\s*textarea\[data-ardia-selection\]::selection \{\s*background-color: var\(--ardia-selection-bg\);\s*color: var\(--ardia-selection-fg\);/);
});
