import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const client = await import("./client.ts");
client.loadChoice();
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));
const { controlStopKind, noteControlRestored, noteControlRestoreTry, noteControlSelfStop, notePageSignals, noteTokenCommands, noteWindowlessPages, takeCliCounts } = await import("./cliCounts.ts");

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

test("the engine's page check totals turn into counts since the last take, and Ardia's own commands count in their own area", () => {
  notePageSignals({ hitTests: 0 }, client.consentNow());
  takeCliCounts();
  notePageSignals({ consoleReads: 2, hitTests: 3, hitTestsFailed: 1, occluded: 1, focusedOrigins: 1, originMismatches: 0 });
  notePageSignals({ consoleReads: 1, hitTests: 2 });
  notePageSignals({ consoleReads: 5, hitTests: 4, hitTestsFailed: 1, occluded: 2, focusedOrigins: 2, originMismatches: 1 });
  noteTokenCommands({ ardia: 7 }, client.consentNow());
  const counts = takeCliCounts();
  assert.deepEqual(
    [counts.cli_page_signal_console_reads, counts.cli_page_signal_hit_tests, counts.cli_page_signal_hit_tests_failed, counts.cli_page_signal_occluded, counts.cli_page_signal_focused_origins, counts.cli_page_signal_origin_mismatches],
    [5, 4, 1, 2, 2, 1],
  );
  assert.equal(counts.cli_cdp_commands_ardia, 7);
  notePageSignals({ consoleReads: 99 }, null);
  assert.equal(takeCliCounts().cli_page_signal_console_reads, 0);
});

test("what stopped the control server is counted by cause, and never carries the message", () => {
  const reasons = {
    policy: "Remote debugging is turned off by your administrator.",
    listen: "Couldn't listen on 127.0.0.1.",
    deadline: "The control server didn't start.",
    stopped: "The control server stopped.",
    other: "Others can write to /Users/someone/Library/Application Support/Ardia.",
  };
  takeCliCounts();
  for (const [kind, reason] of Object.entries(reasons)) {
    assert.equal(controlStopKind(reason), kind);
    noteControlSelfStop(reason);
  }
  noteControlSelfStop("a message this build has never heard of");
  noteControlRestoreTry("launch");
  noteControlRestoreTry("approval");
  noteControlRestoreTry("approval");
  noteControlRestored();
  const counts = takeCliCounts();
  assert.deepEqual(
    Object.keys(reasons).map((kind) => counts[`cli_control_self_stop_${kind}`]),
    [1, 1, 1, 1, 2],
  );
  assert.deepEqual([counts.cli_control_restore_tries_launch, counts.cli_control_restore_tries_approval, counts.cli_control_restored], [1, 2, 1]);
  noteControlSelfStop(reasons.deadline, null);
  noteControlRestoreTry("launch", null);
  noteControlRestored(null);
  const none = takeCliCounts();
  assert.deepEqual([none.cli_control_self_stop_deadline, none.cli_control_restore_tries_launch, none.cli_control_restored], [0, 0, 0], "an earlier or missing consent period counts nothing");
});
