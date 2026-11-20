import assert from "node:assert/strict";
import { test } from "node:test";
import { docs } from "../../test-native/index.ts";
import { flushPersistence, holdPersistence, resumePersistence, startPersistence } from "./persist.ts";
import { useBrowser } from "../browser/store.ts";

const windowsSaved = () => JSON.parse(docs.get("session.json")).windows.length;

test("holding persistence saves what is pending first, writes nothing while held, and saves the held changes on resume", () => {
  const stop = startPersistence();
  try {
    useBrowser.getState().createWindow({ url: "about:blank" });
    assert.equal(holdPersistence(), true);
    const before = windowsSaved();
    assert.equal(before, Object.keys(useBrowser.getState().windows).length);
    useBrowser.getState().createWindow({ url: "about:blank" });
    assert.equal(flushPersistence(), false);
    assert.equal(windowsSaved(), before);
    resumePersistence();
    assert.equal(windowsSaved(), before + 1);
  } finally {
    stop();
    resumePersistence();
  }
});
