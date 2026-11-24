import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findUnguardedWrites, loadProgram, socketRootFiles } from "./socketGuardLint.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the lint catches a write in a then callback, in a destructured action, and through a plain wrapper of an async helper", () => {
  const file = join(appDir, "src", "state", "automation", "lintProbe.ts");
  const probe = `import { useBrowser } from "../browser/store";
import { foreignWriteHooks } from "../browser/foreignWriteHooks";
const store = () => useBrowser.getState();
const foo = async () => undefined;
async function later(id: string) {
  await foo();
  store().closeTabs([id]);
}
export function viaThen(id: string, mayWrite: () => boolean) {
  return foo().then(() => store().closeTabs([id]));
}
export async function viaDestructuring(id: string, mayWrite: () => boolean) {
  const { closeTabs } = store();
  await foo();
  closeTabs([id]);
}
export function viaWrapper(id: string) {
  return later(id);
}
export async function viaTimer(id: string, mayWrite: () => boolean) {
  setTimeout(() => store().closeTabs([id]), 0);
}
export async function viaForEach(ids: string[], mayWrite: () => boolean) {
  await foo();
  ids.forEach((id) => store().closeTabs([id]));
}
const alias = useBrowser;
export async function viaAlias(mayWrite: () => boolean) {
  await foo();
  alias.setState({});
}
export function viaHook(id: string, mayWrite: () => boolean) {
  foreignWriteHooks.around(() => store().closeTabs([id]));
}
export async function halfGuarded(id: string, mayWrite: () => boolean, quick: boolean) {
  await foo();
  if (quick) {
    if (!mayWrite()) return;
  }
  store().closeTabs([id]);
}
export async function guarded(id: string, mayWrite: () => boolean) {
  await foo();
  if (!mayWrite()) return;
  store().closeTabs([id]);
}
`;
  const program = loadProgram(appDir, { [file]: probe });
  const found = findUnguardedWrites(program, [file]).filter((p) => p.includes("lintProbe"));
  assert.ok(found.some((p) => p.includes("viaThen")), found.join("\n"));
  assert.ok(found.some((p) => p.includes("viaDestructuring")), found.join("\n"));
  assert.ok(found.some((p) => p.includes("later")), found.join("\n"));
  for (const name of ["viaTimer", "viaForEach", "viaAlias", "viaHook", "halfGuarded"]) assert.ok(found.some((p) => p.includes(`: ${name} `)), `${name}: ${found.join("\n")}`);
  assert.ok(!found.some((p) => p.includes(": guarded ")), found.join("\n"));
});

const KNOWN_SAFE = new Map([
  ["automation/controlSocket.ts: listen", "the listener is the socket's entry point: each request it hands to handleControlRequest starts its own socket origin in answer(), so its writes are checked there"],
  ["automation/offscreen.ts: offscreenMethod", "the native move already happened; the store has to follow it whether or not the client is still there, or it would point at a page that left"],
  ["sync/engine.ts: cycleOnce", "sync.now only starts a cycle, after checking the caller still holds control; the cycle merges other devices' changes into the store as every timed cycle does, and stopping it halfway when control turns off would leave the sync folder and the store out of step"],
  ["sync/historyAdapter.ts: historyAdapter", "the history adapter is the sync cycle's own write of other devices' history, reached only through cycleOnce, allowed above"],
  ["windows/windowClose.ts: closeAfterAsking", "dropStaleLastWindowMark clears the close's own last-window mark when the close is cancelled or fails; it undoes the close's bookkeeping and has to run whether or not control is still on"],
]);

test("every socket-reachable action that writes the store after an await calls its guard first", () => {
  const program = loadProgram(appDir);
  const found = findUnguardedWrites(program, socketRootFiles(appDir));
  assert.deepEqual(found.filter((p) => ![...KNOWN_SAFE.keys()].some((k) => p.startsWith(`${k} `))), []);
  for (const [site, reason] of KNOWN_SAFE) assert.ok(reason && found.some((p) => p.startsWith(`${site} `)), `${site} is still flagged, so its allowance is still needed`);
});
