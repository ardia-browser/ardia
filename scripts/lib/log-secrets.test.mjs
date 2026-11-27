import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scanLogs } from "./log-secrets.mjs";

const PASSWORD = { label: "fixture password ada", value: "fixture-pw-ada-1" };
const CODE = { label: "Pairing code", value: "482916", whole: true };

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "log-secrets-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

test("a secret in any log file is found, named by its label and file, and the report never holds the value", () => {
  const root = tree({
    "data/app.out.log": `2026 [logins] picked ${PASSWORD.value}\n`,
    "data/Chromium/Default/LOG": "nothing here",
    "fake/requests.jsonl": `{"cmd":4,"host":"example.localhost"}\n`,
  });
  try {
    const { files, hits } = scanLogs({ dirs: [root], secrets: [PASSWORD, CODE] });
    assert.equal(files.length, 3);
    assert.deepEqual(hits.map((h) => [h.file, h.label]), [[join(root, "data/app.out.log"), PASSWORD.label]]);
    assert.ok(!JSON.stringify(hits).includes(PASSWORD.value));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a secret written as UTF-16 counts too", () => {
  const root = tree({ "data/Chromium/Default/Local Storage/leveldb/000003.log": Buffer.from(`x${PASSWORD.value}y`, "utf16le") });
  try {
    assert.equal(scanLogs({ dirs: [root], secrets: [PASSWORD] }).hits.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a code counts only as a whole number, not inside a longer one", () => {
  const root = tree({ "a.log": "pid 14829160 at 1482916\n", "b.log": "code=482916;\n" });
  try {
    assert.deepEqual(scanLogs({ dirs: [root], secrets: [CODE] }).hits.map((h) => h.file), [join(root, "b.log")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only logs are read: a store, a fixture file or the harness's eval channel holding the secret doesn't count", () => {
  const root = tree({
    "fake/fixtures.json": PASSWORD.value,
    "data/Chromium/Default/Login Data": PASSWORD.value,
    "data/dev-eval.js": PASSWORD.value,
    "data/dev-eval-result.json": PASSWORD.value,
    "data/crashes/report.ips": PASSWORD.value,
    "data/Telemetry/local/2026-11-27.jsonl": "{}",
    "data/telemetry-requests.log": "{}",
    "data/freezes.txt": "",
    "fake/started": "1 now",
  });
  try {
    const { files, hits } = scanLogs({ dirs: [root], secrets: [PASSWORD] });
    assert.deepEqual(hits.map((h) => h.file), [join(root, "data/crashes/report.ips")]);
    assert.deepEqual(files.map((f) => f.slice(root.length + 1)).sort(), ["data/Telemetry/local/2026-11-27.jsonl", "data/crashes/report.ips", "data/freezes.txt", "data/telemetry-requests.log", "fake/started"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extra text, such as the system log, is scanned under its own name", () => {
  const { hits } = scanLogs({ dirs: [], secrets: [CODE], extra: { "system log": `{"composedMessage":"paired with 482916"}` } });
  assert.deepEqual(hits.map((h) => [h.file, h.label]), [["system log", CODE.label]]);
});

test("a code inside a UUID is part of that identifier, not a leak; beside other letters it still counts", () => {
  const root = tree({
    "a.log": "nw_connection FA482916-FA27-4C1B-9E0D-1234567890AB ready\nflow 1b2c3d4e-5f60-4718-a9b0-c1d2e3482916 done\n",
    "b.log": "otp=x482916\n",
    "c.log": Buffer.from("id FA482916-FA27-4C1B-9E0D-1234567890AB\n", "utf16le"),
  });
  try {
    assert.deepEqual(scanLogs({ dirs: [root], secrets: [CODE] }).hits.map((h) => h.file), [join(root, "b.log")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
