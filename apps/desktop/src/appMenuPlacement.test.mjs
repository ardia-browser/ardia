import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { inWindowAppMenu, useAppMenuInHeader } from "./appMenuPlacement.ts";

const mode = process.env.ARDIA_DESKTOP_MODE ?? "linux";
const source = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

function MenuProbe() {
  return useAppMenuInHeader() ? createElement("button", { "data-ardia-app-menu": "", "aria-label": "Menu" }) : null;
}

test("macOS keeps the app menus in the native menu bar, so only Linux and Windows draw the in-window menu button", () => {
  assert.equal(inWindowAppMenu, mode !== "mac");
  const html = renderToStaticMarkup(createElement(MenuProbe));
  if (mode === "mac") assert.equal(html, "");
  else assert.match(html, /data-ardia-app-menu/);
});

test("every in-window app menu button asks the platform placement first", () => {
  for (const file of ["./ProfileIndicator.tsx", "./SidebarAddressBar.tsx"]) {
    const text = source(file);
    assert.match(text, /useAppMenuInHeader/, file);
    assert.doesNotMatch(text, /!useMenuBesideWindowButtons\(\)/, file);
  }
  assert.match(source("./ProfileIndicator.tsx"), /const menuInHeader = useAppMenuInHeader\(\);/);
  assert.match(source("./SidebarAddressBar.tsx"), /const menuInHeader = useAppMenuInHeader\(\);/);
});
