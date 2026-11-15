#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStore } from "zustand/vanilla";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
if (args.includes("--help")) {
  console.log(`Times a Bookmarks page drag of a selection into another folder: the store update and the diff sent to Chrome,\nin milliseconds of CPU (the median run), so a busy Mac doesn't skew it.

  node --no-warnings --import ./src/test-loader.mjs scripts/perf/bookmark-move-bench.mjs [options]

  --links N     bookmarks in the source folder (32000)
  --moved N     how many of them are selected, from the top (all)
  --runs N      timed runs after one warm-up (5)
  --each        one moveBookmark per selected bookmark, as the page did before moveBookmarks
  --slice FILE  another copy of state/bookmarks/bookmarks.ts to time (it must sit in that folder)
  --flat FILE   another copy of state/bookmarks/flatBookmarks.ts to time (it must sit in that folder)`);
  process.exit(0);
}
const links = Number(flag("links", 32000));
const moved = Number(flag("moved", links));
const runs = Number(flag("runs", 5));
const each = args.includes("--each");
const moduleAt = (name, fallback) => pathToFileURL(resolve(flag(name, resolve(here, "../../src/state/bookmarks", fallback)))).href;
const { createBookmarksSlice, ensureRoots, rootIdsFor } = await import(moduleAt("slice", "bookmarks.ts"));
const { bookmarkOps, flatFromStore } = await import(moduleAt("flat", "flatBookmarks.ts"));

const roots = rootIdsFor("");
const ids = Array.from({ length: links }, (_, i) => `link-${i}`);
const nodes = { ...ensureRoots({ nodes: {} }, "")[0].nodes };
nodes[roots.other] = { ...nodes[roots.other], children: ["source", "target"] };
nodes.source = { kind: "folder", id: "source", parentId: roots.other, title: "Source", children: ids, addedAt: 0 };
nodes.target = { kind: "folder", id: "target", parentId: roots.other, title: "Target", children: [], addedAt: 0 };
ids.forEach((id, i) => (nodes[id] = { kind: "url", id, parentId: "source", title: `Page ${i}`, url: `https://example.test/${i}`, favicon: null, addedAt: i }));
const start = { nodes };
const selected = ids.slice(0, moved);
const store = createStore((...a) => ({ ...createBookmarksSlice(...a) }));
const shadow = flatFromStore(start, "");

const cpuNow = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const storeMs = [];
const diffMs = [];
let updates = 0;
let ops = [];
store.subscribe(() => updates++);
for (let run = 0; run <= runs; run++) {
  store.setState({ bookmarks: start });
  updates = 0;
  let at = cpuNow();
  if (each) selected.forEach((id, i) => store.getState().moveBookmark(id, "target", i));
  else store.getState().moveBookmarks(selected, "target", 0);
  const storeTook = cpuNow() - at;
  at = cpuNow();
  ops = bookmarkOps(shadow, flatFromStore(store.getState().bookmarks, ""), "");
  const diffTook = cpuNow() - at;
  if (run) {
    storeMs.push(storeTook);
    diffMs.push(diffTook);
  }
}
const after = store.getState().bookmarks.nodes;
const right = after.target.children.length === moved && after.target.children.every((id, i) => id === selected[i]) && after.source.children.length === links - moved && selected.every((id) => after[id].parentId === "target");
console.log(JSON.stringify({ links, moved, mode: each ? "each" : "batch", storeCpuMs: +median(storeMs).toFixed(1), storeUpdates: updates, diffCpuMs: +median(diffMs).toFixed(1), ops: ops.length, right }));
if (!right) process.exit(1);
