import assert from "node:assert/strict";
import { test } from "node:test";

const { noteCdpCommands, noteCliEngineTotals, noteWindowlessPages, takeCliCounts } = await import("./cliCounts.ts");

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

test("the token connection's commands by domain turn into counts since the last take", () => {
  takeCliCounts();
  noteCdpCommands(undefined);
  noteCdpCommands({ dom: 2, browser: 1, other: 0 });
  noteCdpCommands({ dom: 5, browser: 1, other: 3 });
  noteCdpCommands({ dom: 4, browser: 1, other: 3 });
  const counts = takeCliCounts();
  assert.deepEqual([counts.cli_cdp_commands_dom, counts.cli_cdp_commands_browser, counts.cli_cdp_commands_other, counts.cli_cdp_commands_page], [5, 1, 3, 0]);
  noteCdpCommands({ dom: 6, browser: 1, other: 3, page: 1 });
  const next = takeCliCounts();
  assert.deepEqual([next.cli_cdp_commands_dom, next.cli_cdp_commands_page], [1, 1]);
});

test("plugin credential totals from the engine turn into counts since the last take", () => {
  takeCliCounts();
  noteCliEngineTotals({ pluginCredentials: { minted: 0, revoked: 0, refused: 0 } }, "plugins");
  noteCliEngineTotals({ pluginCredentials: { minted: 2, revoked: 1, refused: 4 } }, "plugins");
  noteCliEngineTotals({ pluginCredentials: { minted: 3, revoked: 1, refused: 3 } }, "plugins");
  const counts = takeCliCounts();
  assert.deepEqual([counts.cli_plugin_credentials_minted, counts.cli_plugin_credentials_revoked, counts.cli_plugin_commands_refused], [3, 1, 4]);
});

test("plugin tab holds and busy wheels from the engine turn into counts since the last take", () => {
  takeCliCounts();
  noteCliEngineTotals({ pluginCredentials: { holds: 0, busy: 0 } }, "holds");
  noteCliEngineTotals({ pluginCredentials: { holds: 4, busy: 1 } }, "holds");
  const counts = takeCliCounts();
  assert.deepEqual([counts.cli_plugin_tab_holds, counts.cli_plugin_wheels_busy], [4, 1]);
});

test("act leases the engine granted and the acts it refused turn into counts since the last take", () => {
  takeCliCounts();
  noteCliEngineTotals({ actLeases: { granted: 0, commandsRefused: 0, deliveriesRefused: 0 } }, "leases");
  noteCliEngineTotals({ actLeases: { granted: 4, commandsRefused: 1, deliveriesRefused: 0, live: 1 } }, "leases");
  noteCliEngineTotals({ actLeases: { granted: 6, commandsRefused: 1, deliveriesRefused: 2, live: 0 } }, "leases");
  const counts = takeCliCounts();
  assert.deepEqual([counts.cli_act_leases_granted, counts.cli_act_commands_refused, counts.cli_act_deliveries_refused], [6, 1, 2]);
  noteCliEngineTotals({ actLeases: { granted: 6, commandsRefused: 1, deliveriesRefused: 2 } }, "leases");
  assert.equal(takeCliCounts().cli_act_leases_granted, 0);
});

test("file picker answers the engine counts turn into counts since the last take", () => {
  takeCliCounts();
  noteCliEngineTotals({ filePickerAnswers: { armed: 0, used: 0 } }, "pickers");
  noteCliEngineTotals({ filePickerAnswers: { armed: 3, used: 2 } }, "pickers");
  noteCliEngineTotals({ filePickerAnswers: { armed: 4, used: 2 } }, "pickers");
  const counts = takeCliCounts();
  assert.deepEqual([counts.cli_file_picker_answers_armed, counts.cli_file_picker_answers_used], [4, 2]);
});

test("the first sample of a consent period counts nothing from before it, and a new period takes a new baseline", () => {
  takeCliCounts();
  noteCliEngineTotals({ commandsByDomain: { dom: 40 }, pluginCredentials: { minted: 5, revoked: 0, refused: 9 }, filePickerAnswers: { armed: 2, used: 2 } }, "period-1");
  let counts = takeCliCounts();
  assert.deepEqual([counts.cli_cdp_commands_dom, counts.cli_plugin_credentials_minted, counts.cli_plugin_commands_refused, counts.cli_file_picker_answers_used], [0, 0, 0, 0]);
  noteCliEngineTotals({ commandsByDomain: { dom: 43 }, pluginCredentials: { minted: 6, revoked: 0, refused: 9 }, filePickerAnswers: { armed: 2, used: 2 } }, "period-1");
  counts = takeCliCounts();
  assert.deepEqual([counts.cli_cdp_commands_dom, counts.cli_plugin_credentials_minted], [3, 1]);
  noteCliEngineTotals({ commandsByDomain: { dom: 90 }, pluginCredentials: { minted: 9, revoked: 0, refused: 9 }, filePickerAnswers: { armed: 2, used: 2 } }, "period-2");
  counts = takeCliCounts();
  assert.deepEqual([counts.cli_cdp_commands_dom, counts.cli_plugin_credentials_minted], [0, 0]);
});

test("a family missing from a period's first sample takes its baseline when it first shows up", () => {
  takeCliCounts();
  noteCliEngineTotals({ commandsByDomain: { dom: 1000 } }, "gap-1");
  noteCliEngineTotals({ commandsByDomain: { dom: 1002 } }, "gap-1");
  takeCliCounts();
  noteCliEngineTotals({ pluginCredentials: { minted: 1 } }, "gap-2");
  noteCliEngineTotals({ commandsByDomain: { dom: 1021 }, pluginCredentials: { minted: 1 } }, "gap-2");
  let counts = takeCliCounts();
  assert.equal(counts.cli_cdp_commands_dom, 0);
  noteCliEngineTotals({ commandsByDomain: { dom: 1023 }, pluginCredentials: { minted: 1 } }, "gap-2");
  counts = takeCliCounts();
  assert.equal(counts.cli_cdp_commands_dom, 2);
});
