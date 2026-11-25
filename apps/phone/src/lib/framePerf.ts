export const FRAME_BUDGET_MS = { at60: 1000 / 60, at120: 1000 / 120 } as const;

export type FrameSummary = { frames: number; p50: number; p90: number; max: number; overBudget: number };

const percentile = (sorted: readonly number[], share: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))] ?? 0;

export function summarizeFrames(deltas: readonly number[], budgetMs: number = FRAME_BUDGET_MS.at60): FrameSummary {
  const kept = deltas.filter((delta) => Number.isFinite(delta) && delta > 0);
  const sorted = [...kept].sort((a, b) => a - b);
  return {
    frames: kept.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1] ?? 0,
    overBudget: kept.filter((delta) => delta > budgetMs * 1.5).length,
  };
}

const ms = (value: number) => value.toFixed(1);

const frameText = (thread: string, summary: FrameSummary) =>
  `${thread} ${summary.frames} frames p50 ${ms(summary.p50)} p90 ${ms(summary.p90)} max ${ms(summary.max)} slow ${summary.overBudget}`;

export type LookTotals = { backdropFrames: number; sourceRecordings: number; blurLayerRenders: number; retints: number };

export type LookActivity = { recording: number; holdingLayers: number; animating: number; during?: LookTotals | null };

export function lookTotalsBetween(start: LookTotals | null, end: LookTotals | null): LookTotals | null {
  if (!start || !end) return null;
  return {
    backdropFrames: Math.max(0, end.backdropFrames - start.backdropFrames),
    sourceRecordings: Math.max(0, end.sourceRecordings - start.sourceRecordings),
    blurLayerRenders: Math.max(0, end.blurLayerRenders - start.blurLayerRenders),
    retints: Math.max(0, end.retints - start.retints),
  };
}

const lookText = (look: LookActivity) => {
  const end = `at end recording ${look.recording} holding ${look.holdingLayers} animating ${look.animating}`;
  const during = look.during;
  if (!during) return `look ${end}`;
  return `look drew backdrop ${during.backdropFrames}, recorded ${during.sourceRecordings}, blurred ${during.blurLayerRenders}, retinted ${during.retints}; ${end}`;
};

export function interactionLine(name: string, windowMs: number, js: FrameSummary, ui: FrameSummary | null, renders: ReadonlyMap<string, number>, look: LookActivity | null = null): string {
  const counted = [...renders.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([component, count]) => `${component}=${count}`);
  const total = [...renders.values()].reduce((sum, count) => sum + count, 0);
  return [
    `PAGELAB perf ${name} ${Math.round(windowMs)}ms`,
    frameText("js", js),
    ui ? frameText("ui", ui) : "ui unmeasured",
    `renders ${total}${counted.length ? ` (${counted.join(" ")})` : ""}`,
    look ? lookText(look) : "look unmeasured",
  ].join(" | ");
}
