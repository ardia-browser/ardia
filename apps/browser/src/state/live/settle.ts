import { PartialFetch, type LiveItem, type LiveSourceId } from "./types";

export type SourceFailure = { source: LiveSourceId; error: unknown };

export function settleSources(sources: LiveSourceId[], results: PromiseSettledResult<LiveItem[]>[]) {
  const fetched: LiveItem[] = [];
  const failed: SourceFailure[] = [];
  const partlyFailed: SourceFailure[] = [];
  results.forEach((r, i) => {
    const source = sources[i]!;
    if (r.status === "fulfilled") fetched.push(...r.value);
    else if (r.reason instanceof PartialFetch) {
      fetched.push(...r.reason.items);
      partlyFailed.push(...r.reason.failures.map((error) => ({ source, error })));
    } else failed.push({ source, error: r.reason });
  });
  return { fetched, failed, partlyFailed };
}
