import { MAX_TRACE_EVENTS } from "./devToolsInsights";
import { TRANSPORT_LOSS, type InspectionSession } from "./devToolsSession";
import { OpError } from "./workspaceTargets";

export const TRACE_CATEGORIES = [
  "blink.user_timing",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "latencyInfo",
  "loading",
  "navigation",
  "rail",
  "toplevel",
  "v8.execute",
  "disabled-by-default-v8.compile",
];

export const COMPLETE_TIMEOUT_MS = 15_000;

export type Recording = { events: unknown[]; truncated: boolean; complete: boolean };

export async function recordTrace(session: InspectionSession, options: { durationMs: number; reload: boolean; beforeReload: () => void }): Promise<Recording> {
  let events: unknown[] = [];
  let truncated = false;
  const stop = session.on((method, params) => {
    if (method === TRANSPORT_LOSS) {
      truncated = true;
      return;
    }
    if (method !== "Tracing.dataCollected" || !Array.isArray(params.value)) return;
    const room = MAX_TRACE_EVENTS - events.length;
    if (room <= 0) {
      truncated = true;
      return;
    }
    const chunk = params.value as unknown[];
    if (chunk.length > room) truncated = true;
    for (let i = 0; i < Math.min(room, chunk.length); i++) events.push(chunk[i]);
  });
  try {
    await session.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { recordMode: "recordUntilFull", includedCategories: TRACE_CATEGORIES, excludedCategories: ["*"] } });
    if (options.reload) {
      options.beforeReload();
      await session.send("Page.reload", { ignoreCache: false });
    }
    await session.pause(options.durationMs);
    const done = session.waitFor("Tracing.tracingComplete", COMPLETE_TIMEOUT_MS);
    await session.send("Tracing.end");
    const finished = await done;
    const complete = finished !== null;
    if (finished?.dataLossOccurred === true) truncated = true;
    if (!complete && !events.length) throw new OpError("failed", "The trace didn't finish in time, so there's nothing to analyse.");
    const recorded = events;
    events = [];
    return { events: recorded, truncated, complete };
  } finally {
    stop();
    events = [];
  }
}
