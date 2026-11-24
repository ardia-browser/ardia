import assert from "node:assert/strict";
import test from "node:test";
import { shownTone } from "./pageTone.ts";

test("a page's colours come from the page while it reports them, else from the tab's stored theme colour, as Compose's PageTone.resolve does", () => {
  assert.deepEqual(shownTone({ top: "#111111", bottom: "#222222" }, "#ABCDEF"), { top: "#111111", bottom: "#222222" });
  assert.deepEqual(shownTone(null, "#ABCDEF"), { top: "#ABCDEF", bottom: "#ABCDEF" });
  assert.deepEqual(shownTone({ top: "#111111", bottom: null }, "#ABCDEF"), { top: "#111111", bottom: "#ABCDEF" });
  assert.deepEqual(shownTone(null, null), { top: null, bottom: null });
});
