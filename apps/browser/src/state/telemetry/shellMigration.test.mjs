import assert from "node:assert/strict";
import { test } from "node:test";

const { shellMigrationReport, pendingShellMigration, reportShellMigration, SHELL_MIGRATION_ATTEMPT_DOC, SHELL_MIGRATION_REPORTED_DOC } = await import("./shellMigration.ts");
const { HOST_SHELL } = await import("./hostShell.ts");
const { HOST_SHELL: WEBUI } = await import("./hostShell.win.ts");

const RUN = "0123456789abcdef0123456789abcdef";
const attempt = (overrides = {}) =>
  JSON.stringify({
    version: 1,
    run: RUN,
    outcome: "migrated_with_skips",
    attempt: 2,
    duration_ms: 41,
    counts: { documents: 3, placement: 1, config_files: 2, sync_keys: 1, credentials: 4, credentials_incomplete: 1, skipped_links: 2 },
    ...overrides,
  });

function documents(initial) {
  const docs = new Map(Object.entries(initial));
  return { docs, read: (name) => docs.get(name) ?? null, save: async (name, contents) => void docs.set(name, contents) };
}

test("host_shell is webui on the Windows WebUI build and absent elsewhere", () => {
  assert.equal(HOST_SHELL, null);
  assert.equal(WEBUI, "webui");
});

test("the migration's attempt report becomes enums and counts only", () => {
  const { run, properties } = shellMigrationReport(attempt({ failed_stage: "credentials", outcome: "failed", path: "C:\\Users\\me", counts: { documents: 2, secret: 9, credentials: -1, sync_keys: 1.5, kept_aside: 9e15 } }));
  assert.equal(run, RUN);
  assert.deepEqual(Object.keys(properties).sort(), ["attempt", "config_files", "credential_chunks_orphaned", "credentials", "credentials_incomplete", "documents", "duration_ms", "failed_stage", "kept_aside", "outcome", "partials_swept", "placement", "skipped_case_clash", "skipped_invalid", "skipped_links", "skipped_too_large", "sync_keys", "sync_keys_unreadable", "unchanged"]);
  assert.equal(properties.outcome, "failed");
  assert.equal(properties.failed_stage, "credentials");
  assert.equal(properties.documents, 2);
  assert.equal(properties.credentials, 0);
  assert.equal(properties.sync_keys, 0);
  assert.equal(properties.kept_aside, 1_000_000);
  for (const value of Object.values(properties)) assert.ok(typeof value === "number" || /^[a-z_]+$/.test(value));
});

test("a retry that succeeds still says which stage the attempt before it failed at", () => {
  const { properties } = shellMigrationReport(attempt({ outcome: "migrated", attempt: 3, prior_failed_stage: "credentials" }));
  assert.equal(properties.outcome, "migrated");
  assert.equal(properties.attempt, 3);
  assert.equal(properties.prior_failed_stage, "credentials");
  assert.equal(properties.failed_stage, undefined);
});

test("anything unexpected in the report is not sent", () => {
  for (const text of [null, "", "{", "[]", attempt({ version: 2 }), attempt({ run: "C:\\Users" }), attempt({ run: RUN.toUpperCase() }), attempt({ outcome: "exploded" })]) {
    assert.equal(shellMigrationReport(text), null, String(text));
  }
  assert.equal(shellMigrationReport(attempt({ failed_stage: "C:\\x" })).properties.failed_stage, undefined);
  assert.equal(shellMigrationReport(attempt({ prior_failed_stage: "C:\\x" })).properties.prior_failed_stage, undefined);
  assert.equal("prior_failed_stage" in shellMigrationReport(attempt()).properties, false);
  assert.equal(shellMigrationReport(attempt({ attempt: 0, duration_ms: 1e12 })).properties.attempt, 1);
  assert.equal(shellMigrationReport(attempt({ duration_ms: 1e12 })).properties.duration_ms, 3_600_000);
});

function reporting(store, sharing, sent = []) {
  return { sent, read: store.read, save: store.save, sharing: () => sharing, send: (properties) => (sent.push(properties), true), persisted: async () => true };
}

test("each migration run is reported once, and only after the event was sent", async () => {
  const store = documents({ [SHELL_MIGRATION_ATTEMPT_DOC]: attempt() });
  const on = reporting(store, true);
  assert.equal(await reportShellMigration(on), "reported");
  assert.equal(on.sent[0].credentials, 4);
  assert.deepEqual(JSON.parse(store.docs.get(SHELL_MIGRATION_REPORTED_DOC)), { run: RUN });
  assert.equal(await reportShellMigration(on), "none");
  assert.equal(on.sent.length, 1);
  store.docs.set(SHELL_MIGRATION_ATTEMPT_DOC, attempt({ run: "f".repeat(32), outcome: "migrated" }));
  assert.equal(pendingShellMigration(store.read).properties.outcome, "migrated");
  assert.equal(await reportShellMigration(reporting(documents({}), true)), "none");
});

test("with sharing off the report stays pending, nothing is sent and nothing is marked", async () => {
  const store = documents({ [SHELL_MIGRATION_ATTEMPT_DOC]: attempt() });
  const off = reporting(store, false);
  assert.equal(await reportShellMigration(off), "held");
  assert.equal(off.sent.length, 0);
  assert.equal(store.docs.has(SHELL_MIGRATION_REPORTED_DOC), false);
  assert.equal(await reportShellMigration(reporting(store, true)), "reported");
});

test("a capture that drops or throws leaves the run pending", async () => {
  const store = documents({ [SHELL_MIGRATION_ATTEMPT_DOC]: attempt() });
  assert.equal(await reportShellMigration({ ...reporting(store, true), send: () => false }), "dropped");
  assert.equal(await reportShellMigration({ ...reporting(store, true), send: () => { throw new Error("queue full"); } }), "dropped");
  assert.equal(await reportShellMigration({ ...reporting(store, true), send: () => undefined }), "dropped");
  assert.equal(store.docs.has(SHELL_MIGRATION_REPORTED_DOC), false);
  assert.ok(pendingShellMigration(store.read));
});

test("an event whose queue didn't reach disk leaves the run pending", async () => {
  const store = documents({ [SHELL_MIGRATION_ATTEMPT_DOC]: attempt() });
  assert.equal(await reportShellMigration({ ...reporting(store, true), persisted: async () => false }), "unpersisted");
  assert.equal(await reportShellMigration({ ...reporting(store, true), persisted: () => Promise.reject(new Error("disk")) }), "unpersisted");
  assert.equal(store.docs.has(SHELL_MIGRATION_REPORTED_DOC), false);
  assert.equal(await reportShellMigration(reporting(store, true)), "reported");
});

test("sharing turned off while the queue is being saved leaves the run pending", async () => {
  const store = documents({ [SHELL_MIGRATION_ATTEMPT_DOC]: attempt() });
  let sharing = true;
  const sent = [];
  const outcome = await reportShellMigration({
    read: store.read,
    save: store.save,
    sharing: () => sharing,
    send: (properties) => (sent.push(properties), true),
    persisted: async () => {
      sharing = false;
      return true;
    },
  });
  assert.equal(outcome, "revoked");
  assert.equal(sent.length, 1);
  assert.equal(store.docs.has(SHELL_MIGRATION_REPORTED_DOC), false);
  assert.ok(pendingShellMigration(store.read));
});

test("the launch checks the consent it started with, not whatever consent is current", async () => {
  const { stillValid } = await import("./client.ts");
  const { setConsentPeriod, consentToken } = await import("./consentPeriod.ts");
  setConsentPeriod(true, "launch-epoch");
  const atLaunch = consentToken();
  setConsentPeriod(false, null);
  setConsentPeriod(true, "a-later-epoch");
  try {
    assert.equal(stillValid(atLaunch), false, "a token from before sharing was turned off and on again is not the same consent");
  } finally {
    setConsentPeriod(false, null);
  }
});

test("a relay that drops the event makes capture say so, and the run stays pending", async () => {
  const { capture } = await import("./client.ts");
  const { setTelemetryRelay } = await import("./relay.ts");
  const { setConsentPeriod, consentToken } = await import("./consentPeriod.ts");
  setConsentPeriod(true, "relay-drop");
  const consent = consentToken();
  const relayed = [];
  setTelemetryRelay({ capture: (event) => (relayed.push(event), false), log() {}, resetId: async () => "", change: async () => true, installId: () => "" });
  try {
    assert.equal(capture("shell_migration", { outcome: "migrated" }, consent), false);
    const store = documents({ [SHELL_MIGRATION_ATTEMPT_DOC]: attempt() });
    const outcome = await reportShellMigration({ ...reporting(store, true), send: (properties) => capture("shell_migration", properties, consent) });
    assert.equal(outcome, "dropped");
    assert.equal(store.docs.has(SHELL_MIGRATION_REPORTED_DOC), false);
    assert.deepEqual(relayed, ["shell_migration", "shell_migration"]);
  } finally {
    setTelemetryRelay(null);
    setConsentPeriod(false, null);
  }
});

test("a failed save of the reported mark leaves the run pending for the next launch", async () => {
  const store = documents({ [SHELL_MIGRATION_ATTEMPT_DOC]: attempt() });
  const failing = { ...reporting(store, true), save: async () => Promise.reject(new Error("disk full")) };
  await assert.rejects(reportShellMigration(failing));
  assert.ok(pendingShellMigration(store.read));
});

test("hostile values in the migration's report never reach an event", async () => {
  const { HOSTILE_VALUES } = await import("../../../../../scripts/security/hostile-inputs.mjs");
  for (const { id, value } of HOSTILE_VALUES) {
    for (const field of ["run", "outcome", "failed_stage", "prior_failed_stage", "attempt", "duration_ms", "counts", "version"]) {
      const report = shellMigrationReport(attempt({ [field]: value }));
      if (!report) continue;
      for (const sent of Object.values(report.properties)) assert.ok(typeof sent === "number" ? Number.isSafeInteger(sent) && sent >= 0 : /^[a-z_]+$/.test(sent), `${id} in ${field}`);
    }
    const store = documents({ [SHELL_MIGRATION_ATTEMPT_DOC]: attempt(), [SHELL_MIGRATION_REPORTED_DOC]: typeof value === "string" ? value : JSON.stringify({ run: value }) });
    assert.equal(pendingShellMigration(store.read)?.properties.outcome ?? "migrated_with_skips", "migrated_with_skips", id);
  }
});

test("the launch report waits for the leader: none off the WebUI shell, held while events still go through a relay", async () => {
  const { reportShellMigrationAtLaunch } = await import("./shellMigrationLaunch.ts");
  const { setTelemetryRelay } = await import("./relay.ts");
  assert.equal(await reportShellMigrationAtLaunch(null, null), "none");
  assert.equal(await reportShellMigrationAtLaunch(null, "rnw"), "none");
  setTelemetryRelay({ capture: () => true, log() {}, resetId: async () => "", change: async () => true, installId: () => "" });
  try {
    assert.equal(await reportShellMigrationAtLaunch(null, "webui"), "held");
  } finally {
    setTelemetryRelay(null);
  }
});

test("after the lead hands over, the report runs once with the consent the launch noted, and only if a launch noted one", async () => {
  const { noteLaunchConsent, reportShellMigrationAfterLead } = await import("./shellMigrationLaunch.ts");
  assert.equal(await reportShellMigrationAfterLead(), "none", "a continuing session noted no launch");
  noteLaunchConsent(null);
  assert.equal(await reportShellMigrationAfterLead(), "none", "off the WebUI shell the noted launch sends nothing");
  assert.equal(await reportShellMigrationAfterLead(), "none", "a noted launch is used once");
});
