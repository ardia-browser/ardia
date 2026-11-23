import assert from "node:assert/strict";
import { test } from "node:test";
import "../../test-native/index.ts";
import { flushPersistence, resumePersistence, startPersistence } from "./persist.ts";
import { useBrowser } from "../browser/store.ts";
import { takeSessionWrites } from "../telemetry/sessionWrites.ts";
import { setSharing } from "../telemetry/client.ts";

test("a session save is timed only when the session had changes and sharing is on; a flush with nothing to save isn't counted", () => {
  const stop = startPersistence();
  try {
    setSharing(false, "settings");
    useBrowser.getState().createWindow({ url: "about:blank" });
    flushPersistence();
    assert.equal(takeSessionWrites().session_saves, 0, "sharing off: not counted");
    setSharing(true, "settings");
    flushPersistence();
    takeSessionWrites();
    flushPersistence();
    assert.equal(takeSessionWrites().session_saves, 0, "nothing changed: no save counted");
    useBrowser.getState().createWindow({ url: "about:blank" });
    flushPersistence();
    const taken = takeSessionWrites();
    assert.equal(taken.session_saves, 1);
    assert.equal(taken.session_writes, 1);
    assert.ok(taken.session_save_ms_max >= 0 && taken.session_save_ms_total >= taken.session_save_ms_max);
  } finally {
    setSharing(false, "settings");
    stop();
    resumePersistence();
  }
});
