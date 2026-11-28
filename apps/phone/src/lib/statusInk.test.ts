import assert from "node:assert/strict";
import { test } from "node:test";
import { inkLayer, lightStatusIcons, underStatusBar } from "./statusInk.ts";

const scene = { onboarding: false, voice: false, sheet: false, searching: false, surface: "browsing" as const };

test("the topmost layer decides the status bar, as in the Compose app's StatusBarInk", () => {
  assert.equal(inkLayer(scene), "page");
  assert.equal(inkLayer({ ...scene, surface: "deck" }), "deck");
  assert.equal(inkLayer({ ...scene, surface: "start" }), "search");
  assert.equal(inkLayer({ ...scene, searching: true }), "search");
  assert.equal(inkLayer({ ...scene, searching: true, sheet: true }), "sheet");
  assert.equal(inkLayer({ ...scene, sheet: true, voice: true }), "voice");
  assert.equal(inkLayer({ ...scene, voice: true, onboarding: true }), "cover");
});

test("icons are light on a dark background, under the sheet's scrim, in Incognito and on the voice screen", () => {
  const light = { cover: "#E7CFD3", under: "#E7CFD3", deck: "#E7CFD3", searchDim: null, incognito: false };
  const dark = { cover: "#342123", under: "#342123", deck: "#342123", searchDim: null, incognito: false };
  assert.equal(lightStatusIcons("page", light), null);
  assert.equal(lightStatusIcons("deck", light), false);
  assert.equal(lightStatusIcons("deck", dark), true);
  assert.equal(lightStatusIcons("search", light), false);
  assert.equal(lightStatusIcons("search", { ...light, incognito: true }), true);
  assert.equal(lightStatusIcons("cover", dark), true);
  assert.equal(lightStatusIcons("voice", light), true);
  assert.equal(lightStatusIcons("sheet", light), false);
  assert.equal(lightStatusIcons("sheet", { ...light, under: "#8A7A7E" }), true);
});

test("the sheet's top gap and the search dim show the page under them, so the icons follow the page's top colour through the scrim", () => {
  const scene = { surface: "browsing" as const, pageTop: "#FFFFFF", blankPage: "#F2F2F7", start: "#1A1A1E", deck: "#1A1A1E" };
  const overWhitePage = { cover: "#1A1A1E", under: underStatusBar(scene), deck: "#1A1A1E", searchDim: null, incognito: false };
  assert.equal(lightStatusIcons("sheet", overWhitePage), false, "a white page under a 25% scrim is still light");
  assert.equal(lightStatusIcons("sheet", { ...overWhitePage, under: underStatusBar({ ...scene, pageTop: "#0B0B0B" }) }), true);
  assert.equal(lightStatusIcons("search", { ...overWhitePage, searchDim: "rgba(0,0,0,0.16)" }), false, "a white page under the light dim");
  assert.equal(lightStatusIcons("search", { ...overWhitePage, under: "#202020", searchDim: "rgba(0,0,0,0.42)" }), true);
  assert.equal(underStatusBar({ ...scene, pageTop: null }), "#F2F2F7", "a blank page shows its own surface");
  assert.equal(underStatusBar({ ...scene, surface: "start" }), "#1A1A1E");
  assert.equal(underStatusBar({ ...scene, surface: "deck", deck: "#E7CFD3" }), "#E7CFD3");
});
