import type { PlatformKey } from "./manifestParts";
import type { RegistryPluginPayload, RegistryRevocationsPayload, RegistryVersion } from "./registryTypes";
import { matchRevocations, pickArtifact, type PickedArtifact } from "./revocations";
import { compareVersions, satisfies } from "./semver";

export type Channel = "latest" | "beta";

export type ResolveRoot = { id: string; range?: string; channel?: Channel };

export type Catalog = ReadonlyMap<string, RegistryPluginPayload> | Readonly<Record<string, RegistryPluginPayload>> | ((id: string) => RegistryPluginPayload | undefined);

export type ResolveInput = {
  roots: readonly ResolveRoot[];
  catalog: Catalog;
  ardiaVersion: string;
  sdkVersion?: string;
  platform: PlatformKey | null;
  channel?: Channel;
  installed?: Readonly<Record<string, string>>;
  keepInstalled?: boolean;
  revocations?: RegistryRevocationsPayload | null;
  registry?: string | ((id: string) => string | undefined);
  heldBy?: Readonly<Record<string, readonly { from: string; range: string }[]>>;
  includeOptional?: boolean;
  maxSteps?: number;
};

export type ResolvedPlugin = {
  id: string;
  version: string;
  channel: Channel;
  artifact: PickedArtifact;
  dependencies: string[];
  optionalDependencies: string[];
  optional: boolean;
  root: boolean;
  entry: RegistryVersion;
};

export type ResolveProblemCode = "not-found" | "no-version" | "conflict" | "cycle" | "unsettled";

export type ResolveProblem = { code: ResolveProblemCode; id: string; message: string; wantedBy: string[] };

export type SkippedDependency = { id: string; from: string; range: string; code: ResolveProblemCode; reason: string };

export type ResolveResult = { ok: true; plan: ResolvedPlugin[]; skipped: SkippedDependency[] } | { ok: false; problems: ResolveProblem[] };

type Constraint = { from: string; range: string; channel: Channel };

type Choice = { version: RegistryVersion; artifact: PickedArtifact };

type Picks = ReadonlyMap<string, Choice>;

type Rejection = "range" | "engine" | "channel" | "revoked" | "yanked" | "platform";

const ROOT = "(you)";
const DEFAULT_MAX_STEPS = 50_000;

class Unsettled extends Error {}

const REASONS: Record<Rejection, string> = {
  range: "no version satisfies every range asked for",
  engine: "no version works with this Ardia",
  channel: "only beta versions match",
  revoked: "the matching versions are revoked",
  yanked: "the matching versions are yanked",
  platform: "no matching version has a build for this platform",
};

function lookup(catalog: Catalog, id: string): RegistryPluginPayload | undefined {
  if (typeof catalog === "function") return catalog(id);
  if (catalog instanceof Map) return catalog.get(id);
  return Object.hasOwn(catalog, id) ? (catalog as Record<string, RegistryPluginPayload>)[id] : undefined;
}

const sortedKeys = (record: Readonly<Record<string, string>> | undefined) => Object.keys(record ?? {}).sort();

export function resolvePluginGraph(input: ResolveInput): ResolveResult {
  const defaultChannel = input.channel ?? "latest";
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
  const rootIds = new Set(input.roots.map((r) => r.id));
  const candidateCache = new Map<string, { choices: Choice[]; rejected: Set<Rejection> }>();
  let steps = 0;
  let limit = maxSteps;
  let optionalEdges: ReadonlyMap<string, ReadonlySet<string>> = new Map();
  let lastFailure: ResolveProblem | null = null;

  function candidates(detail: RegistryPluginPayload, constraints: readonly Constraint[]): { choices: Choice[]; rejected: Set<Rejection> } {
    const key = `${detail.id}\u0000${constraints.map((c) => `${c.channel}:${c.range}`).sort().join("\u0000")}`;
    const cached = candidateCache.get(key);
    if (cached) return cached;
    const beta = constraints.some((c) => c.channel === "beta");
    const rejected = new Set<Rejection>();
    const allowed: Choice[] = [];
    const installed = input.installed?.[detail.id];
    for (const version of detail.versions) {
      if (version.yanked) {
        rejected.add("yanked");
        continue;
      }
      if (version.channel === "beta" && !beta) {
        rejected.add("channel");
        continue;
      }
      if (!constraints.every((c) => satisfies(version.version, c.range, { includePrerelease: beta }))) {
        rejected.add("range");
        continue;
      }
      const sdkFits = !input.sdkVersion || !version.engines.sdk || satisfies(input.sdkVersion, version.engines.sdk, { includePrerelease: true });
      if (!satisfies(input.ardiaVersion, version.engines.ardia, { includePrerelease: true }) || !sdkFits) {
        rejected.add("engine");
        continue;
      }
      const artifact = pickArtifact(version, input.platform);
      if (!artifact) {
        rejected.add("platform");
        continue;
      }
      const registry = typeof input.registry === "function" ? input.registry(detail.id) : input.registry;
      const revoked = matchRevocations(
        { id: detail.id, version: version.version, sha256: artifact.sha256, repo: version.repo, ...(registry ? { registry } : {}) },
        input.revocations,
      );
      const keptYank = revoked.every((m) => m.action === "yank") && installed === version.version && input.keepInstalled === true;
      if (revoked.length && !keptYank) {
        rejected.add("revoked");
        continue;
      }
      allowed.push({ version, artifact });
    }
    allowed.sort((a, b) => compareVersions(b.version.version, a.version.version));
    const keptIndex = input.keepInstalled && installed ? allowed.findIndex((c) => c.version.version === installed) : -1;
    if (keptIndex > 0) allowed.unshift(...allowed.splice(keptIndex, 1));
    const result = { choices: allowed, rejected };
    candidateCache.set(key, result);
    return result;
  }

  function constraintsOn(id: string, picks: Picks, extra: readonly Constraint[]): Constraint[] {
    const out: Constraint[] = [];
    for (const root of input.roots) if (root.id === id) out.push({ from: ROOT, range: root.range ?? "*", channel: root.channel ?? defaultChannel });
    for (const held of input.heldBy?.[id] ?? []) if (!picks.has(held.from)) out.push({ from: `${held.from} (installed)`, range: held.range, channel: defaultChannel });
    for (const [from, choice] of picks) {
      const range = choice.version.dependencies[id];
      if (range !== undefined) out.push({ from: `${from}@${choice.version.version}`, range, channel: defaultChannel });
    }
    return [...out, ...extra];
  }

  const fail = (problem: ResolveProblem) => {
    lastFailure = problem;
    return null;
  };

  function search(picks: Picks, pending: readonly string[], extra: ReadonlyMap<string, Constraint[]>): Picks | null {
    if (++steps > limit) throw new Unsettled();
    const index = pending.findIndex((id) => !picks.has(id));
    if (index < 0) return picks;
    const id = pending[index]!;
    const rest = pending.slice(index + 1);
    const constraints = constraintsOn(id, picks, extra.get(id) ?? []);
    const wantedBy = constraints.map((c) => c.from);
    const detail = lookup(input.catalog, id);
    if (!detail) return fail({ code: "not-found", id, message: `${id} isn't in the registry`, wantedBy });
    const { choices, rejected } = candidates(detail, constraints);
    if (!choices.length) {
      const why = [...rejected].map((r) => REASONS[r]).join("; ") || "it has no versions";
      const asked = constraints.map((c) => `${c.from} wants ${c.range}`).join(", ");
      return fail({ code: new Set(wantedBy).size > 1 ? "conflict" : "no-version", id, message: `${id}: ${why} (${asked})`, wantedBy });
    }
    for (const choice of choices) {
      const clash = Object.entries(choice.version.dependencies).find(([dep, range]) => {
        const picked = picks.get(dep);
        return picked !== undefined && !satisfies(picked.version.version, range, { includePrerelease: true });
      });
      if (clash) {
        const [dep, range] = clash;
        fail({
          code: "conflict",
          id: dep,
          message: `${dep}: ${id}@${choice.version.version} wants ${range}, but ${picks.get(dep)!.version.version} is already chosen`,
          wantedBy: [`${id}@${choice.version.version}`, ...constraintsOn(dep, picks, []).map((c) => c.from)],
        });
        continue;
      }
      const next = new Map(picks).set(id, choice);
      const loop = cycleThrough(next, id);
      if (loop) {
        fail({ code: "cycle", id, message: `The plugins depend on each other in a circle: ${loop.join(" → ")}`, wantedBy });
        continue;
      }
      const solved = search(next, [...rest, ...sortedKeys(choice.version.dependencies)], extra);
      if (solved) return solved;
    }
    return null;
  }

  function cycleThrough(picks: Picks, start: string): string[] | null {
    const path: string[] = [start];
    const seen = new Set<string>();
    const walk = (id: string): string[] | null => {
      for (const dep of [...sortedKeys(picks.get(id)?.version.dependencies), ...[...(optionalEdges.get(id) ?? [])].sort()]) {
        if (dep === start) return [...path, start];
        if (!picks.has(dep) || seen.has(dep)) continue;
        seen.add(dep);
        path.push(dep);
        const found = walk(dep);
        if (found) return found;
        path.pop();
      }
      return null;
    };
    return walk(start);
  }

  function reaches(edges: ReadonlyMap<string, readonly string[]>, from: string, to: string): boolean {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(edges.get(id) ?? []));
    }
    return false;
  }

  function edgesOf(picks: Picks, accepted: ReadonlyMap<string, Set<string>>): Map<string, string[]> {
    const edges = new Map<string, string[]>();
    for (const [id, choice] of picks) edges.set(id, [...sortedKeys(choice.version.dependencies), ...[...(accepted.get(id) ?? [])].sort()].filter((dep) => picks.has(dep)));
    return edges;
  }

  try {
    const solved = search(new Map(), [...input.roots.map((r) => r.id)], new Map());
    if (!solved) return { ok: false, problems: [lastFailure ?? { code: "unsettled", id: input.roots[0]?.id ?? "", message: "The dependencies couldn't be resolved", wantedBy: [] }] };
    let picks: Picks = solved;
    const accepted = new Map<string, Set<string>>();
    const skipped: SkippedDependency[] = [];
    const processed = new Set<string>();
    if (input.includeOptional ?? true) {
      for (;;) {
        const edge = [...picks]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .flatMap(([from, choice]) => sortedKeys(choice.version.optionalDependencies).map((dep) => ({ from, dep, range: choice.version.optionalDependencies[dep]!, label: `${from}@${choice.version.version}` })))
          .find((e) => !processed.has(`${e.label}>${e.dep}`));
        if (!edge) break;
        processed.add(`${edge.label}>${edge.dep}`);
        const skip = (code: ResolveProblemCode, reason: string) => skipped.push({ id: edge.dep, from: edge.label, range: edge.range, code, reason });
        const accept = () => accepted.set(edge.from, new Set([...(accepted.get(edge.from) ?? []), edge.dep]));
        const existing = picks.get(edge.dep);
        if (existing) {
          if (!satisfies(existing.version.version, edge.range, { includePrerelease: true })) skip("conflict", `${edge.dep}@${existing.version.version} is already chosen, outside ${edge.range}`);
          else if (reaches(edgesOf(picks, accepted), edge.dep, edge.from)) skip("cycle", `${edge.dep} already depends on ${edge.from}`);
          else accept();
          continue;
        }
        lastFailure = null;
        const extra = new Map([[edge.dep, [{ from: edge.label, range: edge.range, channel: defaultChannel }]]]);
        steps = 0;
        limit = maxSteps;
        optionalEdges = new Map([...accepted, [edge.from, new Set([...(accepted.get(edge.from) ?? []), edge.dep])]]);
        let grown: Picks | null;
        try {
          grown = search(picks, [edge.dep], extra);
        } catch (error) {
          if (!(error instanceof Unsettled)) throw error;
          skip("unsettled", `${edge.dep} didn't settle within ${maxSteps} steps`);
          continue;
        } finally {
          optionalEdges = new Map();
        }
        if (!grown) {
          const failure = lastFailure as ResolveProblem | null;
          skip(failure?.code ?? "no-version", failure?.message ?? `${edge.dep} couldn't be resolved`);
          continue;
        }
        if (reaches(edgesOf(grown, accepted), edge.dep, edge.from)) {
          skip("cycle", `${edge.dep} depends on ${edge.from}`);
          continue;
        }
        picks = grown;
        accept();
      }
    }
    const edges = edgesOf(picks, accepted);
    const required = new Map([...picks].map(([id, choice]) => [id, sortedKeys(choice.version.dependencies)]));
    const reachableByRequired = new Set<string>();
    const walk = [...rootIds];
    while (walk.length) {
      const id = walk.pop()!;
      if (reachableByRequired.has(id)) continue;
      reachableByRequired.add(id);
      walk.push(...(required.get(id) ?? []));
    }
    const plan: ResolvedPlugin[] = [];
    const state = new Map<string, "visiting" | "done">();
    const stack: string[] = [];
    const visit = (id: string): string[] | null => {
      const mark = state.get(id);
      if (mark === "done") return null;
      if (mark === "visiting") return [...stack.slice(stack.indexOf(id)), id];
      state.set(id, "visiting");
      stack.push(id);
      for (const dep of edges.get(id) ?? []) {
        const cycle = visit(dep);
        if (cycle) return cycle;
      }
      stack.pop();
      state.set(id, "done");
      const choice = picks.get(id)!;
      plan.push({
        id,
        version: choice.version.version,
        channel: choice.version.channel,
        artifact: choice.artifact,
        dependencies: sortedKeys(choice.version.dependencies),
        optionalDependencies: [...(accepted.get(id) ?? [])].sort(),
        optional: !reachableByRequired.has(id),
        root: rootIds.has(id),
        entry: choice.version,
      });
      return null;
    };
    for (const id of [...picks.keys()].sort()) {
      const cycle = visit(id);
      if (cycle) return { ok: false, problems: [{ code: "cycle", id: cycle[0]!, message: `The plugins depend on each other in a circle: ${cycle.join(" → ")}`, wantedBy: [] }] };
    }
    return { ok: true, plan, skipped };
  } catch (error) {
    if (!(error instanceof Unsettled)) throw error;
    return { ok: false, problems: [{ code: "unsettled", id: input.roots[0]?.id ?? "", message: `The dependencies didn't settle within ${maxSteps} steps`, wantedBy: [] }] };
  }
}
