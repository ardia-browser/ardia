import { readFileSync } from "node:fs";
import { replay } from "./explore.mjs";

const KNOWN = new URL("./known.json", import.meta.url);
const sequence = (steps) => steps.map(([kind, ...picks]) => ({ kind, picks }));

export async function checkKnown(world) {
  const known = JSON.parse(readFileSync(KNOWN, "utf8"));
  const results = [];
  for (const k of known.failing) {
    const { failure } = await replay(world, sequence(k.steps));
    const still = !!failure && failure.problems.some((p) => p.rule === k.rule);
    results.push({ issue: k.issue, ok: still, line: still ? `#${k.issue} still fails its ${k.rule} rule, as expected until the fix lands` : `✗ #${k.issue}'s sequence no longer fails its ${k.rule} rule: if #${k.issue} is fixed, move it from "failing" to "holding" in scripts/sim/known.json` });
  }
  for (const k of known.holding) {
    const { failure } = await replay(world, sequence(k.steps));
    results.push({ issue: k.issue, ok: !failure, line: failure ? `✗ #${k.issue} is back: ${failure.problems.map((p) => `[${p.rule}] ${p.message}`).join("; ")}` : `#${k.issue} holds` });
  }
  return results;
}
