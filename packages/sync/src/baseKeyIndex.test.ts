import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock } from "./hlc.ts";
import { syncScope } from "./scope.ts";
import { baseKeysWith, dropBase, putBase } from "./scopeKeys.ts";
import { emptyScope, type Adapter, type Transport } from "./scopeState.ts";

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return (n: number) => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) % n;
}

const PREFIXES = ["h:", "bm:", "tabs:", "pin", "pin:"];

test("each prefix's base keys are exactly those a full scan finds, in the base object's order, through puts, drops and re-puts", () => {
  for (let seed = 1; seed <= 120; seed++) {
    const r = rng(seed);
    const state = emptyScope();
    const keys = Array.from({ length: 40 + r(400) }, (_, i) => `${PREFIXES[r(PREFIXES.length)]}${i % 97}-${r(7)}`);
    for (let step = 0; step < 3000; step++) {
      const key = keys[r(keys.length)]!;
      const op = r(10);
      if (op < 5) putBase(state, key, `v${r(3)}`);
      else if (op < 9) dropBase(state, key);
      else {
        const prefix = PREFIXES[r(PREFIXES.length)]!;
        const expected = Object.keys(state.base).filter((k) => k.startsWith(prefix));
        assert.deepEqual([...baseKeysWith(state, prefix)], expected, `seed ${seed} step ${step}: ${prefix}`);
      }
    }
  }
});

test("a key dropped and added again lists after the keys that stayed, as the base object's own order does", () => {
  const state = emptyScope();
  putBase(state, "x:a", "1");
  putBase(state, "x:b", "1");
  assert.deepEqual([...baseKeysWith(state, "x:")], ["x:a", "x:b"]);
  dropBase(state, "x:a");
  putBase(state, "x:a", "2");
  assert.deepEqual([...baseKeysWith(state, "x:")].filter((k) => k in state.base), Object.keys(state.base).filter((k) => k.startsWith("x:")));
});

test("deletions are stamped in the base object's order after a key is dropped and added again", async () => {
  const files: string[] = [];
  const transport: Transport = {
    write: async (_scope, payload) => (files.push(payload), `f${files.length}`),
    read: async (_scope, known) => ({ files: files.map((payload, i) => ({ id: `f${i + 1}`, payload })).filter((f) => !known.includes(f.id)), pending: [], damaged: [], present: files.map((_, i) => `f${i + 1}`) }),
    remove: async () => {},
  };
  let t = 1_000_000;
  const clock = new Clock("A", null, () => t);
  const state = emptyScope();
  let items = new Map<string, string>();
  const adapter: Adapter = { prefix: "x:", extract: () => ({ values: new Map(items) }), apply: () => {} };
  const cycle = () => syncScope({ scope: "s", state, transport, adapters: [adapter], clock, device: "A", now: () => t });
  items = new Map([["x:a", "1"], ["x:b", "1"]]);
  await cycle();
  items = new Map([["x:b", "1"]]);
  await cycle();
  items = new Map([["x:a", "2"], ["x:b", "1"]]);
  await cycle();
  items = new Map();
  await cycle();
  const last = JSON.parse(files[files.length - 1]!) as { ops: { k: string }[] };
  assert.deepEqual(last.ops.map((op) => op.k), Object.keys({ "x:b": 1, "x:a": 1 }));
});
