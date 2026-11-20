import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { downloadFavicon } from "../../../../packages/expo-windows/src/engine/pageFavicon.ts";

const PNG = { uri: "data:image/png;base64,iVBORw0KGgo=", width: 64, height: 64 };

test("a page's favicon is fetched from the engine with the page's profile, not left to the next lookup", async () => {
  const asked = [];
  const favicons = { call: async (name, profile, args) => (asked.push([name, profile, JSON.parse(args)]), JSON.stringify(PNG)) };
  assert.deepEqual(await downloadFavicon(favicons, "Profile 2", "https://developer.mozilla.org/favicon.ico"), PNG);
  assert.deepEqual(asked, [["fetch", "Profile 2", { url: "https://developer.mozilla.org/favicon.ico" }]]);
});

test("no icon, a refused call or a call that throws all answer null", async () => {
  assert.equal(await downloadFavicon({ call: async () => "null" }, "", "https://example.com/a.ico"), null);
  assert.equal(await downloadFavicon({ call: async () => { throw new Error("no engine"); } }, "", "https://example.com/a.ico"), null);
  assert.equal(await downloadFavicon({ call: () => { throw new Error("no module"); } }, "", "https://example.com/a.ico"), null);
});

test("the Windows web view answers downloadFavicon itself instead of logging it as missing", () => {
  const source = readFileSync(new URL("../../../../packages/expo-windows/src/engine/EngineWebView.tsx", import.meta.url), "utf8");
  assert.match(source, /method === "downloadFavicon"\) return \(url: string\) => downloadFavicon\(faviconsDomain\(\), latest\.current\.profile/);
});
