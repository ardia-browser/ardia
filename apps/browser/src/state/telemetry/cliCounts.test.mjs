import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const client = await import("./client.ts");
client.loadChoice();
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));
const { noteTokenCommands, noteVisibleHolds, noteWindowlessPages, takeCliCounts } = await import("./cliCounts.ts");

const windowless = (counts) => [counts.windowless_pages_given_geometry, counts.windowless_pages_missing_geometry];

test("the engine's running totals of windowless pages turn into counts since the last take", () => {
  noteWindowlessPages(undefined);
  assert.deepEqual(windowless(takeCliCounts()), [0, 0]);
  noteWindowlessPages({ given: 3, missed: 0 });
  noteWindowlessPages({ given: 3, missed: 0 });
  noteWindowlessPages({ given: 5, missed: 1 });
  assert.deepEqual(windowless(takeCliCounts()), [5, 1]);
  assert.deepEqual(windowless(takeCliCounts()), [0, 0]);
});

test("a status that arrives out of order never counts a page twice or takes one back", () => {
  noteWindowlessPages({ given: 8, missed: 1 });
  noteWindowlessPages({ given: 7, missed: 1 });
  noteWindowlessPages({ given: 8, missed: 2 });
  assert.deepEqual(windowless(takeCliCounts()), [3, 1]);
});

test("the engine's running totals of token commands turn into per-area counts since the last take", () => {
  noteTokenCommands(undefined, client.consentNow());
  takeCliCounts();
  noteTokenCommands({ dom: 4, browser: 1 });
  noteTokenCommands({ dom: 3, browser: 1, other: 2 });
  noteTokenCommands({ dom: 6, browser: 2, other: 2 });
  const counts = takeCliCounts();
  assert.deepEqual([counts.cli_cdp_commands_dom, counts.cli_cdp_commands_browser, counts.cli_cdp_commands_other, counts.cli_cdp_commands_page], [6, 2, 2, 0]);
  assert.equal(takeCliCounts().cli_cdp_commands_dom, 0);
});

test("token command totals read without consent count nothing", () => {
  takeCliCounts();
  noteTokenCommands({ dom: 50, browser: 9 }, null);
  assert.equal(takeCliCounts().cli_cdp_commands_dom, 0);
});

test("an expired token counts nothing, and the next valid reading only sets the new period's baseline", () => {
  noteTokenCommands({ dom: 100 }, client.consentNow());
  takeCliCounts();
  const old = client.consentNow();
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  noteTokenCommands({ dom: 110 }, old);
  assert.equal(takeCliCounts().cli_cdp_commands_dom, 0);
  noteTokenCommands({ dom: 115 }, client.consentNow());
  assert.equal(takeCliCounts().cli_cdp_commands_dom, 0);
  noteTokenCommands({ dom: 118 }, client.consentNow());
  assert.equal(takeCliCounts().cli_cdp_commands_dom, 3);
});

const holds = (counts) => [counts.cli_visible_holds_started, counts.cli_visible_holds_ended_before_start];

test("the engine's running totals of visible holds turn into counts since the last take, out of order or not", () => {
  noteVisibleHolds(undefined, client.consentNow());
  noteVisibleHolds({ started: 0, endedBeforeStart: 0 }, client.consentNow());
  takeCliCounts();
  noteVisibleHolds({ started: 4, endedBeforeStart: 1 });
  noteVisibleHolds({ started: 3, endedBeforeStart: 1 });
  noteVisibleHolds({ started: 6, endedBeforeStart: 2 });
  assert.deepEqual(holds(takeCliCounts()), [6, 2]);
  assert.deepEqual(holds(takeCliCounts()), [0, 0]);
});

test("visible hold totals read without consent, or in an earlier sharing period, count nothing", () => {
  noteVisibleHolds({ started: 10, endedBeforeStart: 3 }, null);
  assert.deepEqual(holds(takeCliCounts()), [0, 0]);
  const old = client.consentNow();
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  noteVisibleHolds({ started: 12, endedBeforeStart: 4 }, old);
  assert.deepEqual(holds(takeCliCounts()), [0, 0]);
  noteVisibleHolds({ started: 13, endedBeforeStart: 4 }, client.consentNow());
  assert.deepEqual(holds(takeCliCounts()), [0, 0]);
  noteVisibleHolds({ started: 15, endedBeforeStart: 5 }, client.consentNow());
  assert.deepEqual(holds(takeCliCounts()), [2, 1]);
});
