import { controlOwnsTab } from "../../platform/control";
import { isIncognitoProfile } from "../browser/model";
import { noteDevTools } from "../telemetry/cliCounts";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { fetchFieldData, fieldDataOrigin, type FieldData, type FieldDataRequest } from "./devToolsFieldData";
import { analyzeTrace, overallRating, traceEventsOf, type InsightId, type TraceInsights } from "./devToolsInsights";
import { withInspection } from "./devToolsSession";
import { recordTrace } from "./devToolsTrace";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { bool, int, obj, oneOf, TAB, text } from "./socketSchema";
import { tabOf } from "./socketTargets";
import { OpError } from "./workspaceTargets";

const INSIGHT_IDS: InsightId[] = ["lcp-breakdown", "cls-culprits", "inp-breakdown", "long-tasks", "render-blocking", "document-latency", "network-bottlenecks"];

const FIELD_DATA_PARAMS = {
  includeFieldData: bool("Also ask the public field-data service for real-user metrics of the traced page's origin. Off unless you set it; sends only that origin, never a path or query"),
  fieldDataKey: text("Your API key for the field-data service; needed with includeFieldData"),
  formFactor: oneOf(["PHONE", "DESKTOP", "TABLET"], "Field data for one device class; all when left out"),
};

const timed = <T>(work: () => T, consent: ConsentToken | null): T => {
  const started = Date.now();
  try {
    return work();
  } finally {
    noteDevTools("trace_analysis_ms", Date.now() - started, consent);
  }
};

function only(result: TraceInsights, insight: unknown) {
  if (typeof insight !== "string") return result;
  return { ...result, insights: result.insights.filter((i) => i.id === insight) };
}

function checkFieldDataAsk(params: Record<string, unknown>, profileId: string): { apiKey: string; formFactor: FieldDataRequest["formFactor"] } | null {
  if (params.includeFieldData !== true) return null;
  if (isIncognitoProfile(profileId)) throw new OpError("refused", "Field data is never asked for a private window's page.");
  if (typeof params.fieldDataKey !== "string") throw new OpError("bad_request", "includeFieldData needs fieldDataKey.");
  return { apiKey: params.fieldDataKey, formFactor: (params.formFactor as FieldDataRequest["formFactor"] | undefined) ?? null };
}

type FieldDataAnswer = FieldData | { skipped: string } | null;

async function fieldDataAfterTrace(ask: ReturnType<typeof checkFieldDataAsk>, tabId: string, tracedUrl: string | null, consent: ConsentToken | null): Promise<FieldDataAnswer> {
  if (!ask) return null;
  const pageUrl = tabOf(tabId).url;
  let origin: string;
  try {
    origin = fieldDataOrigin(pageUrl);
  } catch {
    return { skipped: "The tab no longer shows a web page." };
  }
  if (!tracedUrl) return { skipped: "The trace has no page load to tie field data to; record with reload." };
  if (fieldDataOrigin(tracedUrl) !== origin) return { skipped: "The page changed origin during the trace, so field data wouldn't match it." };
  noteDevTools("field_data_requests", 1, consent);
  return fetchFieldData({ pageUrl, apiKey: ask.apiKey, formFactor: ask.formFactor });
}

const tracedPage = (result: TraceInsights) => {
  const url = result.navigation?.url ?? null;
  if (!url) return null;
  try {
    fieldDataOrigin(url);
    return url;
  } catch {
    return null;
  }
};

async function perfTrace(params: Record<string, unknown>, call: SocketCall) {
  const consent = consentToken();
  const tab = tabOf(params.tab);
  const reload = params.reload === true;
  if (reload && !(await controlOwnsTab(tab.id)).owned) throw new OpError("refused", "Only a tab the ardia command opened can be reloaded for a trace.");
  call.stillServing();
  const durationMs = (params.durationMs as number | undefined) ?? 5000;
  const ask = checkFieldDataAsk(params, tab.profileId);
  try {
    const recording = await withInspection(tab.id, call.connection, (session) => {
      call.stillServing();
      return recordTrace(session, { durationMs, reload, beforeReload: call.stillServing });
    });
    call.stillServing();
    const result = timed(() => analyzeTrace(recording.events), consent);
    noteDevTools("traces", 1, consent);
    const fieldData = await fieldDataAfterTrace(ask, tab.id, tracedPage(result), consent);
    return { tab: tab.id, durationMs, reloaded: reload, complete: recording.complete, ...only({ ...result, truncated: result.truncated || recording.truncated }, params.insight), rating: overallRating(result), fieldData };
  } catch (error) {
    noteDevTools("trace_failures", 1, consent);
    throw error;
  }
}

async function perfInsight(params: Record<string, unknown>) {
  const consent = consentToken();
  const { events, truncated } = traceEventsOf(params.trace);
  if (!events.length) throw new OpError("bad_request", "trace must be a list of trace events or an object with traceEvents.");
  const result = timed(() => analyzeTrace(events), consent);
  return { ...only({ ...result, truncated: result.truncated || truncated }, params.insight), rating: overallRating(result) };
}

export const DEVTOOLS_PERF_METHODS: MethodSpec[] = [
  {
    name: "devtools.perfTrace",
    mutates: false,
    description: "Record a performance trace of a tab in its own DevTools session (no emulation or network override of yours is touched) and answer Core Web Vitals with insights: LCP phases, layout-shift culprits, INP phases, long tasks, render-blocking and slow requests. reload needs a tab the command opened",
    params: obj(
      {
        tab: TAB,
        durationMs: int("How long to record, in milliseconds (default 5000)", 250, 30000),
        reload: bool("Reload the tab at the start so loading metrics are measured; only for a tab the command opened"),
        insight: oneOf(INSIGHT_IDS, "Answer only this insight"),
        ...FIELD_DATA_PARAMS,
      },
      ["tab"],
    ),
    result: "{tab, durationMs, reloaded, complete, navigation, metrics:{fcp, lcp, ttfb, tbt, inp, cls}, insights:[{id, title, rating, summary, savingsMs, details}], counts, truncated, rating, fieldData}",
    run: perfTrace,
  },
  {
    name: "devtools.perfInsight",
    mutates: false,
    description: "Analyse a trace you already have (a list of trace events, or {traceEvents}) into the same metrics and insights devtools.perfTrace answers",
    params: obj({ trace: { type: ["array", "object"], description: "Trace events, or an object with traceEvents" }, insight: oneOf(INSIGHT_IDS, "Answer only this insight") }, ["trace"]),
    result: "{navigation, metrics, insights, counts, truncated, rating}",
    run: perfInsight,
  },
];
