import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { load, until } from "./support/build.mjs";

const M = await load();
const { model, database: D, fflate } = M;
const FIX = fileURLToPath(new URL("./fixtures/import/notion/", import.meta.url));
const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

function exportFiles(prefix) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[`${prefix}/${relative(FIX, full)}`] = new Uint8Array(readFileSync(full));
    }
  };
  walk(FIX);
  return out;
}

const zipOf = (files) => fflate.zipSync(Object.fromEntries(Object.entries(files).map(([path, data]) => [path, [data, { level: 6 }]])));

async function notesWith() {
  const data = mkdtempSync(join(tmpdir(), "notes-sync-data-"));
  const zips = mkdtempSync(join(tmpdir(), "notes-sync-zips-"));
  const files = M.nodeFiles({ data, pzipsync00001: zips });
  cleanups.push(() => files.detach());
  const reads = [];
  const read = files.read.bind(files);
  files.read = (path, options) => {
    reads.push(path);
    return read(path, options);
  };
  const storage = new Map();
  const hub = M.pageHub();
  let picked = null;
  const notes = new M.Notes({
    files,
    folders: M.fakeFolders(files, join(data, "..", "notes-sync-shared")),
    storage: { get: async (k) => structuredClone(storage.get(k)), set: async (k, v) => void storage.set(k, structuredClone(v)) },
    setting: () => "",
    post: hub.post,
    openPage: async () => {},
    openUrl: async () => {},
    store: { debounceMs: 20, rescanMs: 60_000 },
    pickFiles: async () => (picked ? [picked] : []),
  });
  hub.attach(notes);
  cleanups.push(() => notes.stop());
  await notes.start();
  const ws = notes.workspaces()[0].id;
  const run = async (zip, name = "Export.zip") => {
    writeFileSync(join(zips, name), zip);
    picked = { id: "pzipsync00001", name, size: zip.length };
    const started = await notes.call("importStart", { workspace: ws, source: "notion", pick: "file" });
    const job = await until(async () => {
      const j = await notes.call("importStatus", { job: started.job });
      return ["done", "failed", "cancelled"].includes(j.state) ? j : null;
    }, 20_000, "zip import");
    assert.equal(job.state, "done", job.error);
    return job;
  };
  const tree = () => notes.tree(notes.spaces.get(ws));
  const doc = (page) => notes.docOf(notes.spaces.get(ws), `p-${page}`);
  return { notes, ws, run, tree, doc, reads };
}

const imported = (tree) => {
  const roots = new Set(Object.values(tree.getMap("imports").toJSON()).flatMap((r) => r.roots ?? []));
  const pages = model.allPages(tree);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const inside = (p) => {
    for (let at = p, depth = 0; at && depth < 64; at = byId.get(at.parent), depth++) if (roots.has(at.id)) return true;
    return false;
  };
  return pages.filter(inside);
};
const live = (tree) => imported(tree).filter((p) => !p.archivedAt);
const byTitle = (tree, title) => {
  const found = live(tree).filter((p) => p.title === title);
  assert.equal(found.length, 1, `one live page titled ${title}`);
  return found[0];
};

test("Notion zip pages take ids from the Notion ids in their file names, with the export folder left out", () => {
  assert.equal(M.notionStableKey("Export-1e9c5325-aaba-40af-b957-12645ffcadbd/Home d796c5d6364e47189085506d5782b588"), "d796c5d6364e47189085506d5782b588");
  assert.equal(M.notionStableKey("Home D796C5D6364E47189085506D5782B588/Sub page 0123456789abcdef0123456789abcdef"), "0123456789abcdef0123456789abcdef");
  assert.equal(M.notionStableKey("Export-1e9c5325-aaba-40af-b957-12645ffcadbd/Tasks 22222222222222222222222222222222/#row2"), "22222222222222222222222222222222:row2");
  assert.equal(M.notionStableKey("Export-1e9c5325-aaba-40af-b957-12645ffcadbd/Loose notes"), "path:Loose notes");
  assert.notEqual(M.syncedId("ws0000000001", "abc"), M.syncedId("ws0000000002", "abc"), "ids are scoped to the workspace");
  assert.match(M.syncedId("ws0000000001", "abc"), /^[0-9a-f]{12}$/);
});

test("importing the same Notion zip again updates its pages in place instead of making a second tree", async () => {
  const n = await notesWith();
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => warned.push(String(args[0]));
  let first;
  try {
    first = await n.run(zipOf(exportFiles("Export-aaaaaaaa-0000-4000-8000-000000000001")));
  } finally {
    console.warn = original;
  }
  assert.deepEqual(warned.filter((w) => /Yjs/.test(w)), []);
  const t1 = await n.tree();
  const before = live(t1);
  const root = before.find((p) => p.id === first.root);
  const workspace = byTitle(t1, "Workspace");
  const tasks = byTitle(t1, "Tasks");
  const spec = byTitle(t1, "Write spec");
  const propIds = D.readSchema(await n.doc(tasks.id)).map((p) => p.id);
  const imports = Object.entries(t1.getMap("imports").toJSON());
  assert.equal(imports.length, 1);
  assert.ok(imports[0][0].startsWith(M.SYNCED_EXPORT_PREFIX));
  assert.equal(workspace.id, M.syncedId(n.ws, "0123456789abcdef0123456789abcdef"));

  const second = await n.run(zipOf(exportFiles("Export-bbbbbbbb-0000-4000-8000-000000000002")), "Export again.zip");
  const t2 = await n.tree();
  assert.equal(second.root, first.root, "the import's top page is reused");
  assert.equal(live(t2).length, before.length, "no page is added twice");
  assert.deepEqual(new Set(live(t2).map((p) => p.id)), new Set(before.map((p) => p.id)));
  assert.equal(Object.keys(t2.getMap("imports").toJSON()).length, 1);
  assert.deepEqual(D.readSchema(await n.doc(tasks.id)).map((p) => p.id), propIds, "database properties keep their ids");
  assert.equal(byTitle(t2, "Write spec").id, spec.id);
  assert.equal(root.title, model.getPage(t2, first.root).title);
});

test("a changed Notion export updates edited pages, adds new ones and moves pages gone from Notion to the trash", async () => {
  const n = await notesWith();
  const prefix = "Export-cccccccc-0000-4000-8000-000000000003";
  const files = exportFiles(prefix);
  await n.run(zipOf(files));
  const t1 = await n.tree();
  const projects = byTitle(t1, "Projects");
  const spec = byTitle(t1, "Write spec");
  const specDoc = await n.doc(spec.id);
  const projectsPath = Object.keys(files).find((p) => p.endsWith("Projects 11111111111111111111111111111111.md"));
  const specPath = Object.keys(files).find((p) => p.endsWith("Write spec 33333333333333333333333333333333.md"));
  const changed = { ...files };
  delete changed[projectsPath];
  changed[specPath] = new TextEncoder().encode("# Write spec\n\nRewritten in Notion.\n");
  changed[`${prefix}/Fresh idea 44444444444444444444444444444444.md`] = new TextEncoder().encode("# Fresh idea\n\nNew since last time.\n");
  const before = n.reads.length;
  await n.run(zipOf(changed), "Export changed.zip");
  const t2 = await n.tree();
  assert.ok(model.getPage(t2, projects.id).archivedAt > 0, "a page gone from the export moves to the trash");
  assert.equal(byTitle(t2, "Write spec").id, spec.id);
  assert.equal(await n.doc(spec.id), specDoc, "the open page's doc is updated, not replaced");
  const text = JSON.stringify(model.blocksOf(specDoc).toJSON());
  assert.match(text, /Rewritten in Notion/);
  const fresh = byTitle(t2, "Fresh idea");
  assert.equal(fresh.id, M.syncedId(n.ws, "44444444444444444444444444444444"));
  assert.ok(n.reads.length > before);
});

test("re-importing an unchanged zip leaves page content and attachments alone", async () => {
  const n = await notesWith();
  const zip = zipOf(exportFiles("Export-dddddddd-0000-4000-8000-000000000004"));
  await n.run(zip);
  const t1 = await n.tree();
  const spec = byTitle(t1, "Write spec");
  const workspace = byTitle(t1, "Workspace");
  const specDoc = await n.doc(spec.id);
  const workspaceDoc = await n.doc(workspace.id);
  const updates = [];
  specDoc.on("update", () => updates.push("spec"));
  workspaceDoc.on("update", () => updates.push("workspace"));
  const record = Object.values(t1.getMap("imports").toJSON())[0];
  assert.ok(Object.keys(record.files ?? {}).length >= 1, "the image's mark is kept");
  await n.run(zip, "Export same.zip");
  assert.deepEqual(updates, [], "unchanged pages get no edits");
  const t2 = await n.tree();
  const image = JSON.stringify(model.blocksOf(workspaceDoc).toJSON()).match(/file:[0-9a-f]{64}/);
  assert.ok(image, "the image still points at the stored file");
  assert.equal(live(t2).length, live(t1).length);
});
