import assert from "node:assert/strict";
import { test } from "node:test";
import { appUrlOrigin, appUrlRoute } from "./appUrls.ts";

test("an app address that can't be split into path, query and hash routes nowhere instead of throwing", () => {
  for (const url of ["ardia://history#x\ny", "ardia://settings#a\nb", "ardia://bookmarks?q=1#a\nb"]) {
    assert.equal(appUrlRoute(url), null, JSON.stringify(url));
    assert.equal(appUrlOrigin(url), null, JSON.stringify(url));
  }
});

test("listed app pages still route, with or without a query and hash", () => {
  assert.deepEqual(appUrlRoute("ardia://history"), { kind: "page", page: "history" });
  assert.deepEqual(appUrlRoute("ardia://bookmarks?q=x#top"), { kind: "page", page: "bookmarks" });
  assert.equal(appUrlRoute("ardia://settings")?.kind, "settings");
});
