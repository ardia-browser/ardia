import assert from "node:assert/strict";
import { after, test } from "node:test";
import { docs } from "../../test-native/index.ts";
import * as client from "./client.ts";
import { noteSamePageTint, tintChangedOnSamePage } from "./toolbarTintChanges.ts";
import { sessionEnding } from "./usage.ts";
const { WHATS_SENT } = await import("./copy.ts");

const KEY = "toolbar_tint_changes_same_page";
const usageCounts = () => JSON.parse(docs.get("telemetry-queue.json") ?? '{"events":[]}').events.filter((event) => event.event === "usage_counts");
const sent = () => usageCounts().map((event) => event.properties[KEY]);

const tab = () => {
  let previous = null;
  let lastPage = null;
  return (url, shown, isLoading = false) => {
    noteSamePageTint({ previous, shown, url, lastPage, isLoading });
    previous = shown;
    lastPage = url.replace(/#.*$/, "");
  };
};

after(() => client.setSharing(false, "settings"));

test("a colour change on the same page counts once, a change across a navigation or while loading does not", () => {
  const page = { previous: "#ffffff", shown: "#101010", url: "https://example.com/feed", lastPage: "https://example.com/feed", isLoading: false };
  assert.equal(tintChangedOnSamePage(page), true);
  assert.equal(tintChangedOnSamePage({ ...page, shown: "#ffffff" }), false);
  assert.equal(tintChangedOnSamePage({ ...page, isLoading: true }), false);
  assert.equal(tintChangedOnSamePage({ ...page, url: "https://example.com/other" }), false);
  assert.equal(tintChangedOnSamePage({ ...page, lastPage: null }), false);
  assert.equal(tintChangedOnSamePage({ ...page, url: "https://example.com/feed#top" }), true);
});

test("toolbar tint changes on one page are counted, written to usage_counts and drained", async () => {
  client.loadChoice();
  client.setSharing(false, "settings");
  const off = tab();
  off("https://example.com/a", "#ffffff");
  off("https://example.com/a", "#202020");
  sessionEnding();
  await client.saveQueueNow();
  assert.deepEqual(sent(), []);

  client.setSharing(true, "onboarding");
  const one = tab();
  one("https://example.com/a", "#ffffff", true);
  one("https://example.com/a", "#ffffff");
  one("https://example.com/a", "#202020");
  one("https://example.com/a", "#202020");
  one("https://example.com/b", "#ff0000", true);
  one("https://example.com/b", "#ff0000");
  one("https://example.com/c", "#00ff00");
  one("https://example.com/c#frag", "#00ff00");
  one("https://example.com/c#frag", "#0000ff", true);
  sessionEnding();
  await client.saveQueueNow();
  assert.deepEqual(sent(), [1]);
  const [event] = usageCounts();
  assert.ok(!JSON.stringify(event).match(/example\.com|#[0-9a-f]{6}/i));

  sessionEnding();
  await client.saveQueueNow();
  assert.deepEqual(sent(), [1]);
});

test("What's Sent lists the toolbar colour count without the page or the colour", () => {
  const line = WHATS_SENT.flatMap((group) => group.items).find((item) => item.includes("toolbar's colour changed while you stayed on the same page"));
  assert.ok(line);
  assert.match(line, /Never which page or which colour$/);
});
