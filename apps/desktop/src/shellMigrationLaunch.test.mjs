import assert from "node:assert/strict";
import test from "node:test";
import { createHostDocuments } from "./hostDocuments.ts";
import { TELEMETRY_DOCUMENTS } from "./telemetryDocuments.ts";
import { reportShellMigration, SHELL_MIGRATION_ATTEMPT_DOC, SHELL_MIGRATION_REPORTED_DOC } from "../../browser/src/state/telemetry/shellMigration.ts";

const REPORT = JSON.stringify({ version: 1, run: "0123456789abcdef0123456789abcdef", outcome: "migrated", attempt: 1, duration_ms: 12, counts: { documents: 4, credentials: 2 } });

function webUIHost(disk, writes = "store") {
  return {
    bootstrap: { windowId: "main", profileId: "default", documents: { "telemetry.json": "{}" } },
    invoke(method, { args }) {
      if (method === "ArdiaShell.readDocument") return disk.get(args[0]) ?? null;
      if (method === "ArdiaShell.writeDocument") {
        if (writes === "refuse") throw Object.assign(new Error("not served"), { code: "ERR_UNAVAILABLE" });
        if (writes === "ignore") return null;
        return void disk.set(args[0], args[1]);
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

async function launch(disk, sharing, writes = "store") {
  const documents = createHostDocuments(webUIHost(disk, writes));
  assert.equal(documents.read(SHELL_MIGRATION_ATTEMPT_DOC), null, "the bootstrap doesn't carry the report");
  await Promise.all(TELEMETRY_DOCUMENTS.map((name) => documents.refresh(name)));
  const sent = [];
  const outcome = await reportShellMigration({
    read: documents.read,
    save: async (name, contents) => {
      await documents.write(name, contents);
      await documents.saved(name);
    },
    sharing: () => sharing,
    send: (properties) => (sent.push(properties), true),
    persisted: async () => true,
  }).catch((error) => `unsaved: ${error.code}`);
  return { outcome, sent };
}

test("the telemetry leader loads the migration report from disk before the launch events read it", async () => {
  assert.ok(TELEMETRY_DOCUMENTS.includes(SHELL_MIGRATION_ATTEMPT_DOC));
  assert.ok(TELEMETRY_DOCUMENTS.includes(SHELL_MIGRATION_REPORTED_DOC));
  const disk = new Map([[SHELL_MIGRATION_ATTEMPT_DOC, REPORT]]);
  const held = await launch(disk, false);
  assert.deepEqual(held, { outcome: "held", sent: [] });
  assert.equal(disk.has(SHELL_MIGRATION_REPORTED_DOC), false, "sharing off leaves the run pending");
  const shared = await launch(disk, true);
  assert.equal(shared.outcome, "reported");
  assert.equal(shared.sent[0].documents, 4);
  assert.deepEqual(JSON.parse(disk.get(SHELL_MIGRATION_REPORTED_DOC)), { run: "0123456789abcdef0123456789abcdef" });
  assert.deepEqual(await launch(disk, true), { outcome: "none", sent: [] });
});

test("a host that refuses or ignores the write never makes the run look reported on disk", async () => {
  const disk = new Map([[SHELL_MIGRATION_ATTEMPT_DOC, REPORT]]);
  const refused = await launch(disk, true, "refuse");
  assert.equal(refused.outcome, "unsaved: ERR_UNAVAILABLE");
  assert.equal(disk.has(SHELL_MIGRATION_REPORTED_DOC), false);
  const ignored = await launch(disk, true, "ignore");
  assert.equal(ignored.outcome, "reported", "the renderer can't tell an unserved write from a served one");
  assert.equal(disk.has(SHELL_MIGRATION_REPORTED_DOC), false, "but nothing claims it was stored");
  const next = await launch(disk, true);
  assert.equal(next.outcome, "reported", "so the next launch sends it again: a duplicate, never a lost report");
});

test("on a host that serves no documents (today's Windows pilot) nothing is read or sent", async () => {
  const pilot = {
    bootstrap: { windowId: "main", profileId: "default", documents: {} },
    invoke: () => null,
  };
  const documents = createHostDocuments(pilot);
  await Promise.all(TELEMETRY_DOCUMENTS.map((name) => documents.refresh(name)));
  const sent = [];
  const outcome = await reportShellMigration({
    read: documents.read,
    save: (name, contents) => documents.write(name, contents),
    sharing: () => true,
    send: (properties) => (sent.push(properties), true),
    persisted: async () => true,
  });
  assert.deepEqual({ outcome, sent }, { outcome: "none", sent: [] });
});
