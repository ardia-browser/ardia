import { canonical } from "./canon.ts";
import { ABSENT, launchOf, queueRecovered } from "./applyBatches.ts";
import { dropBase, putBase, visible } from "./scopeKeys.ts";
import type { ApplyBatch, Extraction, ScopeOptions, ScopeState } from "./scopeState.ts";

type Step = { at: number; from: string; to: string; partial: boolean };
export type ExtractWith = (baseJson: (key: string) => string | undefined) => Promise<Extraction | null>;

const nativeJson = (extraction: Extraction, key: string) => {
  if (!extraction.values.has(key)) return ABSENT;
  const value = extraction.values.get(key);
  return extraction.json?.(key, value) ?? canonical(value);
};

function setBase(state: ScopeState, key: string, json: string) {
  if (json === ABSENT) dropBase(state, key);
  else putBase(state, key, json);
}

function chainsOf(batches: ApplyBatch[], skip: (key: string) => boolean) {
  const chains = new Map<string, Step[]>();
  batches.forEach((batch, at) => {
    for (const [key, [from, to]] of Object.entries(batch.k)) {
      if (skip(key)) continue;
      let chain = chains.get(key);
      if (!chain) chains.set(key, (chain = []));
      chain.push({ at, from: from ?? ABSENT, to: to ?? ABSENT, partial: !batch.ok });
    }
  });
  return chains;
}

function valueAt(chain: Step[], hypothesis: number): string {
  let last: Step | undefined;
  for (const step of chain) if (step.at < hypothesis) last = step;
  return last ? last.to : chain[0]!.from;
}

const holds = (chain: Step[] | undefined, json: string) => !!chain?.some((s) => s.to === json || s.from === json);
const leftOver = (chain: Step[], json: string, savesWhole: boolean) => (!savesWhole || chain.some((s) => s.partial)) && holds(chain, json);

type Trial = { hypothesis: number; extraction: Extraction; matches: number; baseJson: (key: string) => string | undefined };

async function tryHypothesis(state: ScopeState, chains: Map<string, Step[]>, hypothesis: number, first: Extraction, extractWith: ExtractWith | null): Promise<Trial> {
  const overrides = new Map<string, string>();
  for (const [key, chain] of chains) overrides.set(key, valueAt(chain, hypothesis));
  const baseJson = (key: string) => {
    const json = overrides.has(key) ? overrides.get(key)! : state.base[key];
    return json === ABSENT ? undefined : json;
  };
  const same = [...overrides].every(([key, json]) => (state.base[key] ?? ABSENT) === json);
  const extraction = same || !extractWith ? first : await extractWith(baseJson);
  if (!extraction) return { hypothesis, extraction: first, matches: -1, baseJson };
  let matches = 0;
  for (const [key, chain] of chains) {
    if (extraction.ignore?.(key)) continue;
    if (nativeJson(extraction, key) === valueAt(chain, hypothesis)) matches++;
  }
  return { hypothesis, extraction, matches, baseJson };
}

function keepUnresolved(state: ScopeState, batches: ApplyBatch[], resolved: Set<string>) {
  const kept: ApplyBatch[] = [];
  for (const batch of state.applying ?? []) {
    if (!batches.includes(batch)) {
      kept.push(batch);
      continue;
    }
    const left = Object.entries(batch.k).filter(([key]) => !resolved.has(key));
    const cut = Object.keys(batch.k).filter((key) => resolved.has(key));
    if (left.length) kept.push({ ...batch, r: 1, ...(cut.length ? { cut: [...(batch.cut ?? []), ...cut] } : {}), k: Object.fromEntries(left) });
  }
  if (kept.length) state.applying = kept;
  else delete state.applying;
}

export async function recoverBatches(state: ScopeState, prefix: string, first: Extraction, extractWith: ExtractWith | null, savesWhole: boolean, options: ScopeOptions = {}): Promise<Extraction | null> {
  const launch = launchOf(options);
  const batches = (state.applying ?? []).filter((b) => b.p === prefix && b.l !== launch).sort((a, z) => a.id - z.id);
  if (!batches.length) return first;
  const chains = chainsOf(batches, (key) => !!first.ignore?.(key));
  if (!chains.size) {
    if (batches.some((b) => !b.r)) keepUnresolved(state, batches, new Set());
    return first;
  }
  let best: Trial | null = null;
  for (let hypothesis = 0; hypothesis <= batches.length; hypothesis++) {
    const trial = await tryHypothesis(state, chains, hypothesis, first, extractWith);
    if (trial.matches < 0) return null;
    if (!best || trial.matches > best.matches) best = trial;
  }
  const { extraction, hypothesis, baseJson } = best!;
  const view = visible(state, prefix);
  const sinceRestart = chainsOf((state.applying ?? []).filter((b) => b.p === prefix && b.l === launch), (key) => !chains.has(key));
  const resolved = new Set<string>();
  const queue: string[] = [];
  for (const [key, chain] of chains) {
    if (extraction.ignore?.(key)) continue;
    resolved.add(key);
    const actual = nativeJson(extraction, key);
    if (actual !== valueAt(chain, hypothesis) && !leftOver(chain, actual, savesWhole) && !holds(sinceRestart.get(key), actual)) {
      setBase(state, key, baseJson(key) ?? ABSENT);
      continue;
    }
    setBase(state, key, actual);
    const target = view.has(key) ? canonical(view.get(key)) : ABSENT;
    const recordBehind = target !== actual && chain.some((s) => s.from === target) && !chain.some((s) => s.to === target);
    if (recordBehind) continue;
    queue.push(key);
  }
  keepUnresolved(state, batches, resolved);
  queueRecovered(state, queue);
  return extraction;
}
