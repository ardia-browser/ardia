import assert from "node:assert/strict";
import test from "node:test";
import { clockTime } from "./libraryText.ts";

test("the cached clock reads the same as the date's own time string, in the default locale and others", () => {
  const times = [Date.UTC(2026, 10, 16, 0, 5), Date.UTC(2026, 10, 16, 12, 30), Date.UTC(2026, 6, 1, 23, 59)];
  for (const at of times) {
    assert.equal(clockTime(at), new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
    assert.equal(clockTime(at, "de-DE"), new Date(at).toLocaleTimeString("de-DE", { hour: "numeric", minute: "2-digit" }));
    assert.equal(clockTime(at, "en-US"), new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
  }
});
