import assert from "node:assert/strict";
import { after, test } from "node:test";
import { noteStripHoverCard, takeStripHoverCardCounts } from "./stripHoverCards.ts";
globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("./client.ts");
client.loadChoice();
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));

test("strip hover cards are counted, those for another profile's tab apart, and taking them starts over", () => {
  noteStripHoverCard(false);
  noteStripHoverCard(false);
  noteStripHoverCard(true);
  assert.deepEqual(takeStripHoverCardCounts(), { tab_strip_hover_cards: 3, tab_strip_hover_cards_other_profile: 1 });
  assert.deepEqual(takeStripHoverCardCounts(), { tab_strip_hover_cards: 0, tab_strip_hover_cards_other_profile: 0 });
});
