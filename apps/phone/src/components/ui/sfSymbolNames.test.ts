import assert from "node:assert/strict";
import test from "node:test";
import { SF_SYMBOL_ALIASES } from "../../lib/sfSymbols.ts";
import { SF_SYMBOL_NAMES, sfName } from "./sfSymbolNames.ts";

const canonical: [string, string][] = Object.entries(SF_SYMBOL_NAMES).flatMap(([symbol, systemName]) => (systemName ? [[symbol, systemName as string] as [string, string]] : []));

test("a menu's SF Symbol for an app symbol is the one the app draws on screen", () => {
  for (const [symbol, systemName] of canonical) assert.equal(sfName(symbol), systemName, symbol);
  assert.equal(sfName("eyes"), undefined);
  assert.equal(sfName("notASymbol"), undefined);
  assert.equal(sfName(null), undefined);
});

test("every accepted SF input names an app symbol that exists", () => {
  for (const [input, symbol] of Object.entries(SF_SYMBOL_ALIASES)) assert.ok(symbol in SF_SYMBOL_NAMES, `${input} → ${symbol}`);
});

test("an SF input that is some symbol's canonical name comes back as a symbol drawn with that same name", () => {
  for (const [input, symbol] of Object.entries(SF_SYMBOL_ALIASES)) {
    if (!canonical.some(([, systemName]) => systemName === input)) continue;
    assert.equal(SF_SYMBOL_NAMES[symbol as keyof typeof SF_SYMBOL_NAMES], input, `${input} is read as ${symbol}, which draws ${SF_SYMBOL_NAMES[symbol as keyof typeof SF_SYMBOL_NAMES]}`);
  }
});

test("Copy Link and copying text keep separate glyphs", () => {
  assert.equal(SF_SYMBOL_NAMES.link, "link");
  assert.equal(SF_SYMBOL_NAMES.docOnDoc, "doc.on.doc");
  assert.equal(SF_SYMBOL_NAMES.sidebarLeft, "sidebar.left");
});
