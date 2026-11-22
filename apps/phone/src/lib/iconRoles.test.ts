import assert from "node:assert/strict";
import { test } from "node:test";
import { iconRoleSymbols } from "./iconRoles.ts";

test("one glyph per meaning: Copy Link is the link glyph, Copy Text the two pages, Share the box and arrow", () => {
  assert.equal(iconRoleSymbols.copyLink, "link");
  assert.equal(iconRoleSymbols.copyText, "docOnDoc");
  assert.equal(iconRoleSymbols.share, "squareAndArrowUp");
  assert.equal(new Set(Object.values(iconRoleSymbols)).size, Object.keys(iconRoleSymbols).length);
});
