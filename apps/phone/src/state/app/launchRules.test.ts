import assert from "node:assert/strict";
import test from "node:test";
import { manyTabTitle, sampleToast } from "./launchRules.ts";

test("ArdiaToast's sample names give Compose's sample toasts, and an unknown name gives none", () => {
  assert.deepEqual(sampleToast("copied"), { title: "Copied Link", icon: "link" });
  assert.deepEqual(sampleToast("received"), { title: "Tab from MacBook Pro", icon: "laptop" });
  assert.deepEqual(sampleToast("receivedSeveral"), { title: "3 Tabs from MacBook Pro", icon: "laptop" });
  assert.deepEqual(sampleToast("sent"), { title: "Sent to MacBook Pro", detail: "example.com", icon: "sent" });
  assert.equal(sampleToast("pinned")?.icon, "star");
  assert.equal(sampleToast("cleared")?.title, "Cleared Browsing Data");
  assert.equal(sampleToast("downloading")?.progress, 0.45);
  assert.equal(sampleToast("downloadsGrouped")?.title, "2 downloads complete");
  assert.equal(sampleToast("downloadFailed")?.title, "Couldn’t download quarterly-report.pdf");
  assert.equal(sampleToast("party"), null);
});

test("the deck script's many tabs give every seventh a title long enough to truncate", () => {
  assert.equal(manyTabTitle(1), "Article 2");
  assert.ok(manyTabTitle(7).length > 80);
});
