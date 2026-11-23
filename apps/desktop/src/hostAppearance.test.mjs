import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { IS_DARK_APPEARANCE_METHOD, SET_APPEARANCE_METHOD, createAppearance } from "./hostAppearance.ts";

function fakeQuery(matches = false) {
  const listeners = new Set();
  return {
    matches,
    addEventListener: (_type, listener) => listeners.add(listener),
    change(next) {
      this.matches = next;
      for (const listener of listeners) listener({ matches: next });
    },
  };
}

function fakeEngine({ systemDark = false, capabilities = [SET_APPEARANCE_METHOD] } = {}) {
  const invoked = [];
  let override = null;
  return {
    invoked,
    host: {
      bootstrap: { windowId: "main", profileId: "default", capabilities },
      invoke: async (method, { args }) => {
        invoked.push([method, args]);
        if (method === SET_APPEARANCE_METHOD) return void (override = args[0] === "auto" ? null : args[0]);
        if (method === IS_DARK_APPEARANCE_METHOD) return override ? override === "dark" : systemDark;
        throw new Error(`Unknown host method ${method}`);
      },
      call: async () => "{}",
      onEvent: () => () => {},
    },
  };
}

test("Dark, Light and Auto reach the engine, so pages and the shell see the scheme it applies", async () => {
  const { host, invoked } = fakeEngine({ systemDark: false });
  const emitted = [];
  const appearance = createAppearance(host, fakeQuery(false), (dark) => emitted.push(dark));
  await appearance.setAppearance("dark");
  assert.equal(await appearance.isDarkAppearance(), true);
  await appearance.setAppearance("light");
  assert.equal(await appearance.isDarkAppearance(), false);
  await appearance.setAppearance("auto");
  assert.deepEqual(invoked.filter(([method]) => method === SET_APPEARANCE_METHOD), [
    [SET_APPEARANCE_METHOD, ["dark"]], [SET_APPEARANCE_METHOD, ["light"]], [SET_APPEARANCE_METHOD, ["auto"]],
  ]);
  assert.deepEqual(emitted, [true, false, false]);
});

test("Auto reports the system scheme from the engine, not a local guess", async () => {
  const { host } = fakeEngine({ systemDark: true });
  const emitted = [];
  const appearance = createAppearance(host, fakeQuery(false), (dark) => emitted.push(dark));
  assert.equal(await appearance.isDarkAppearance(), true);
  await appearance.setAppearance("light");
  await appearance.setAppearance("auto");
  assert.deepEqual(emitted, [false, true]);
});

test("with the engine applying the scheme, the shell page's own media query is the effective appearance in every mode", async () => {
  const { host } = fakeEngine();
  const query = fakeQuery(false);
  const emitted = [];
  const appearance = createAppearance(host, query, (dark) => emitted.push(dark));
  await appearance.setAppearance("dark");
  emitted.length = 0;
  query.change(true);
  assert.deepEqual(emitted, [true]);
});

test("a repeated mode is not sent again, and a failed send can be retried", async () => {
  const { host, invoked } = fakeEngine();
  let failing = true;
  const invoke = host.invoke;
  host.invoke = async (method, args) => {
    if (method === SET_APPEARANCE_METHOD && failing) throw new Error("engine busy");
    return invoke(method, args);
  };
  const appearance = createAppearance(host, fakeQuery(false), () => {});
  await assert.rejects(appearance.setAppearance("dark"), /engine busy/);
  failing = false;
  await appearance.setAppearance("dark");
  await appearance.setAppearance("dark");
  assert.deepEqual(invoked.filter(([method]) => method === SET_APPEARANCE_METHOD), [[SET_APPEARANCE_METHOD, ["dark"]]]);
});

test("an engine without the call keeps the local answer and only Auto follows the page query", async () => {
  const { host, invoked } = fakeEngine({ capabilities: [] });
  const query = fakeQuery(false);
  const emitted = [];
  const appearance = createAppearance(host, query, (dark) => emitted.push(dark));
  await appearance.setAppearance("dark");
  assert.equal(await appearance.isDarkAppearance(), true);
  query.change(true);
  await appearance.setAppearance("auto");
  query.change(false);
  assert.deepEqual(emitted, [true, true, false]);
  assert.deepEqual(invoked, []);
});

test("the shell module's setAppearance and isDarkAppearance come from the engine-aware appearance", () => {
  const shell = readFileSync(new URL("./shims/shellBase.tsx", import.meta.url), "utf8");
  assert.match(shell, /createAppearance\(ardiaHost, darkQuery, \(dark\) => emitAppEvent\(\{ type: "appearance", dark \}\)\)/);
  assert.doesNotMatch(shell, /let appearance: "auto" \| "light" \| "dark"/);
});
