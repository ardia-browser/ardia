import assert from "node:assert/strict";
import test from "node:test";
import { manyTabTitle, sampleToast } from "./launchRules.ts";

test("ArdiaToast's sample names give Compose's sample toasts, and an unknown name gives none", () => {
  assert.deepEqual(sampleToast("copied"), { message: "Copied Link", icon: "link" });
  assert.deepEqual(sampleToast("received"), { message: "Tab from MacBook Pro", icon: "laptop" });
  assert.deepEqual(sampleToast("receivedSeveral"), { message: "3 Tabs from MacBook Pro", icon: "laptop" });
  assert.deepEqual(sampleToast("sent"), { message: "Sent to MacBook Pro", icon: "sent" });
  assert.equal(sampleToast("pinned")?.icon, "star");
  assert.equal(sampleToast("cleared")?.message, "Cleared Browsing Data");
  assert.equal(sampleToast("party"), null);
});

test("the deck script's many tabs give every seventh a title long enough to truncate", () => {
  assert.equal(manyTabTitle(1), "Article 2");
  assert.ok(manyTabTitle(7).length > 80);
});
