import { seededRandom, shrinkSequence } from "./rng.mjs";
import { generateSteps } from "./world.mjs";
import { createPinLedger, stepProblems } from "./rules.mjs";

export async function replay(world, steps, { onStep, rules = () => true } = {}) {
  await world.reset();
  world.takeErrors();
  const ledger = createPinLedger(world);
  ledger.reset();
  const trace = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    let outcome;
    try {
      outcome = await world.run(step);
    } catch (error) {
      trace.push({ step, detail: `threw ${error?.message ?? error}` });
      return { failure: { index: i, problems: [{ rule: "throws", message: `${step.kind} threw: ${String(error?.stack ?? error).split("\n").slice(0, 3).join(" | ")}` }] }, trace };
    }
    const errors = world.takeErrors();
    if (outcome.skipped) {
      const problems = [...ledger.check(outcome).map((message) => ({ rule: "pins", message })), ...errors.map((message) => ({ rule: "errors", message }))].filter((p) => rules(p.rule));
      if (problems.length) {
        trace.push({ step, detail: `${step.kind} (skipped: nothing to act on)` });
        return { failure: { index: i, problems }, trace };
      }
      continue;
    }
    outcome.errors = errors;
    trace.push({ step, detail: outcome.detail });
    onStep?.(step, outcome);
    const problems = stepProblems(world, ledger, outcome).filter((p) => rules(p.rule));
    if (problems.length) return { failure: { index: i, problems }, trace };
  }
  return { failure: null, trace };
}

export async function exploreSeed(world, seed, { steps = 60, weights, rules, shrink = true, onStep, shrinkBudget } = {}) {
  const sequence = generateSteps(seededRandom(seed), steps, weights);
  const first = await replay(world, sequence, { rules, onStep });
  if (!first.failure) return { seed, ok: true };
  const target = first.failure.problems[0].rule;
  const failsTheSameWay = async (candidate) => {
    const again = await replay(world, candidate, { rules });
    return !!again.failure && again.failure.problems.some((p) => p.rule === target);
  };
  let minimal = sequence.slice(0, first.failure.index + 1);
  let tries = 0;
  if (shrink) ({ steps: minimal, tries } = await shrinkSequence(minimal, failsTheSameWay, shrinkBudget ? { budget: shrinkBudget } : {}));
  const shrunk = await replay(world, minimal, { rules });
  return {
    seed,
    ok: false,
    rule: target,
    original: first.failure.index + 1,
    shrinkTries: tries,
    steps: minimal,
    trace: shrunk.trace.map((t) => t.detail),
    problems: (shrunk.failure ?? first.failure).problems,
  };
}

export function describeFailure(f) {
  const lines = [`seed ${f.seed}: ${f.rule} broke after ${f.original} steps; shrunk to ${f.steps.length} (${f.shrinkTries} replays)`];
  f.trace.forEach((d, i) => lines.push(`  ${i + 1}. ${d}`));
  for (const p of f.problems) lines.push(`  ✗ [${p.rule}] ${p.message}`);
  lines.push(`  replay: ${JSON.stringify(f.steps.map((s) => [s.kind, ...s.picks]))}`);
  return lines.join("\n");
}
