import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, until } from "./support/build.mjs";

const M = await load();
const { model, database: D } = M;
const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

function device(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "notes-agent-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  const files = M.nodeFiles({ data: join(dir, "data") });
  const storage = new Map();
  const hub = M.pageHub();
  const opened = [];
  const host = {
    files,
    folders: M.fakeFolders(files, join(dir, "shared"), []),
    storage: { get: async (k) => (storage.has(k) ? structuredClone(storage.get(k)) : undefined), set: async (k, v) => void storage.set(k, structuredClone(v)) },
    setting: () => "",
    post: hub.post,
    openPage: async () => {},
    openUrl: async () => {},
    store: { debounceMs: 5, rescanMs: 200 },
    agentDemoPauseMs: 5,
    ...extra,
  };
  const notes = new M.Notes(host);
  hub.attach(notes);
  cleanups.push(async () => {
    await notes.stop();
    files.detach();
  });
  return { notes, storage, opened };
}

test("agentStatus reports what Ardia says, and unknown when this Ardia can't tell", async () => {
  const old = device();
  await old.notes.start();
  assert.deepEqual(await old.notes.call("agentStatus", {}), { known: false, command: false, control: false });
  assert.deepEqual(await old.notes.call("openArdiaSettings", { pane: "advanced" }), { ok: false });
  const panes = [];
  const d = device({ controlStatus: async () => ({ command: true, control: false }), openArdiaSettings: async (pane) => (panes.push(pane), true) });
  await d.notes.start();
  assert.deepEqual(await d.notes.call("agentStatus", {}), { known: true, command: true, control: false });
  assert.deepEqual(await d.notes.call("openArdiaSettings", { pane: "plugins" }), { ok: true });
  assert.deepEqual(panes, ["plugins"]);
  await assert.rejects(d.notes.call("openArdiaSettings", { pane: "general" }), /one of plugins, advanced/);
  const broken = device({ controlStatus: async () => { throw new Error("gone"); } });
  await broken.notes.start();
  assert.equal((await broken.notes.call("agentStatus", {})).known, false);
});

test("Watch it work: the scripted tool calls build a page, an inline database and a board, step by step, with no tool counts", async () => {
  const d = device();
  await d.notes.start();
  const [ws] = d.notes.workspaces();
  const { job } = await d.notes.call("agentDemo", { workspace: ws.id });
  const first = await d.notes.call("agentDemoStatus", { job });
  assert.equal(first.state, "running");
  assert.ok(first.steps.length >= 6);
  const run = await until(async () => {
    const r = await d.notes.call("agentDemoStatus", { job });
    return r.state !== "running" ? r : null;
  }, 10_000, "demo done");
  assert.equal(run.state, "done", run.error);
  assert.ok(run.steps.every((s) => s.done && s.command.startsWith("ardia plugins call notes ")));
  assert.ok(!run.steps.some((s) => s.command.includes(ws.id)), "the shown commands leave the workspace out");
  const tree = d.notes.treeOf(ws.id);
  const page = model.getPage(tree, run.page);
  assert.equal(page.title, "Launch plan");
  assert.equal(page.icon, "🚀");
  const db = model.allPages(tree).find((p) => p.title === "Launch tasks" && p.kind === "database");
  assert.ok(db, "the database exists");
  const rows = model.childrenOf(tree, db.id);
  assert.deepEqual(rows.map((r) => r.title).sort(), ["Draft the plan", "Record the demo", "Write release notes"]);
  assert.equal(d.storage.get("toolCounts"), undefined, "the demo doesn't count as agent use");
  await assert.rejects(d.notes.call("agentDemoStatus", { job: "nothex" }), /demo id/);
  assert.equal(await d.notes.call("agentDemoStatus", { job: "000000000000" }), null);
});
