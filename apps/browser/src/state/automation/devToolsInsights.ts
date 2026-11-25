import { buildModel, documentRequest, fcpOf, field, frameOf, lcpOf, ms, num, text, traceEventsOf, withoutFragment, type Ev, type Fields, type Lcp, type Model, type RequestRow } from "./devToolsTraceModel";

export { MAX_TRACE_EVENTS, traceEventsOf } from "./devToolsTraceModel";
export type { RequestRow } from "./devToolsTraceModel";

const MAX_LISTED = 10;
const LONG_TASK_US = 50_000;
const SHIFT_GAP_US = 1_000_000;
const SHIFT_WINDOW_US = 5_000_000;
const CULPRIT_WINDOW_US = 500_000;

export type Rating = "good" | "needs-improvement" | "poor";
export type Metric = { ms: number; rating: Rating };
export type InsightId = "lcp-breakdown" | "cls-culprits" | "inp-breakdown" | "long-tasks" | "render-blocking" | "document-latency" | "network-bottlenecks";
export type Insight = { id: InsightId; title: string; rating: Rating; summary: string; savingsMs: number | null; details: Fields };

export type TraceInsights = {
  navigation: { url: string; navigationId: string | null } | null;
  metrics: { fcp: Metric | null; lcp: Metric | null; ttfb: Metric | null; tbt: Metric | null; inp: Metric | null; cls: { value: number; rating: Rating } };
  insights: Insight[];
  counts: { events: number; requests: number; layoutShifts: number; interactions: number; longTasks: number };
  truncated: boolean;
};


const THRESHOLDS = { lcp: [2500, 4000], fcp: [1800, 3000], ttfb: [800, 1800], tbt: [200, 600], inp: [200, 500], cls: [0.1, 0.25] } as const;

const rate = (value: number, [good, poor]: readonly [number, number]): Rating => (value <= good ? "good" : value <= poor ? "needs-improvement" : "poor");
const metric = (us: number | null, limits: readonly [number, number]): Metric | null => (us === null || us < 0 ? null : { ms: ms(us), rating: rate(ms(us), limits) });
const worst = (ratings: Rating[]): Rating => (ratings.includes("poor") ? "poor" : ratings.includes("needs-improvement") ? "needs-improvement" : "good");

const rel = (model: Model, ts: number) => ms(ts - model.origin);

function lcpInsight(model: Model, lcp: Lcp | null, doc: RequestRow | null): Insight | null {
  if (!lcp) return null;
  const lcpUs = lcp.ts - model.origin;
  const ttfbEnd = doc?.headersEndTs ?? null;
  const ttfb = ttfbEnd === null ? null : Math.max(0, ttfbEnd - model.origin);
  const resource = lcp.url ? [...model.requests.values()].find((row) => withoutFragment(row.url) === withoutFragment(lcp.url!)) ?? null : null;
  const phases: Fields = { ttfbMs: ttfb === null ? null : ms(ttfb) };
  let biggest: [string, number] = ttfb === null ? ["renderDelayMs", 0] : ["ttfbMs", ttfb];
  const note = (key: string, us: number) => {
    const value = Math.max(0, us);
    phases[key] = ms(value);
    if (value > biggest[1]) biggest = [key, value];
  };
  if (resource && resource.finishTs !== null) {
    const documentReady = ttfbEnd ?? model.origin;
    const loadStart = Math.min(Math.max(resource.sendTs, documentReady), lcp.ts);
    const loadEnd = Math.min(Math.max(resource.finishTs, loadStart), lcp.ts);
    note("loadDelayMs", loadStart - documentReady);
    note("loadDurationMs", loadEnd - loadStart);
    note("renderDelayMs", lcp.ts - loadEnd);
  } else {
    note("renderDelayMs", lcp.ts - (ttfbEnd ?? model.origin));
  }
  const rating = rate(ms(lcpUs), THRESHOLDS.lcp);
  const advice: Record<string, string> = {
    ttfbMs: "The server answers the document slowly: cache the HTML at the edge, avoid redirects and speed up server work.",
    loadDelayMs: "The LCP resource is discovered late: reference it in the HTML or preload it with fetchpriority=high.",
    loadDurationMs: "The LCP resource takes long to download: compress it, serve a smaller size or a modern format, or use a CDN.",
    renderDelayMs: "The LCP element renders late after its content is ready: reduce render-blocking CSS and main-thread work before it paints.",
  };
  return {
    id: "lcp-breakdown",
    title: "Largest Contentful Paint breakdown",
    rating,
    summary: `LCP at ${ms(lcpUs)} ms (${lcp.type ?? "element"}); the largest phase is ${biggest[0].replace(/Ms$/, "")}. ${advice[biggest[0]] ?? ""}`.trim(),
    savingsMs: rating === "good" ? 0 : ms(Math.max(0, lcpUs - THRESHOLDS.lcp[0] * 1000)),
    details: { element: { nodeId: lcp.nodeId, type: lcp.type, size: lcp.size, url: lcp.url }, phases, resource: resource ? requestDetail(model, resource) : null },
  };
}

function requestDetail(model: Model, row: RequestRow) {
  return {
    requestId: row.requestId,
    url: row.url,
    priority: row.priority,
    renderBlocking: row.renderBlocking,
    mimeType: row.mimeType,
    status: row.status,
    startMs: rel(model, row.sendTs),
    endMs: row.finishTs === null ? null : rel(model, row.finishTs),
    durationMs: row.finishTs === null ? null : ms(Math.max(0, row.finishTs - row.sendTs)),
    encodedBytes: row.encodedBytes,
    failed: row.failed,
  };
}

type Shift = { ts: number; score: number; nodes: number[] };

function shiftsOf(model: Model): Shift[] {
  const shifts: Shift[] = [];
  for (const ev of model.events) {
    if (ev.name !== "LayoutShift" || ev.ts < model.origin) continue;
    if (model.mainFrame && frameOf(ev) && frameOf(ev) !== model.mainFrame) continue;
    const data = ev.args.data;
    if (field(data, "had_recent_input") === true) continue;
    const score = num(field(data, "weighted_score_delta")) ?? num(field(data, "score"));
    if (score === null || score <= 0) continue;
    const impacted = field(data, "impacted_nodes");
    const nodes = Array.isArray(impacted) ? impacted.map((n) => num(field(n, "node_id"))).filter((n): n is number => n !== null).slice(0, MAX_LISTED) : [];
    shifts.push({ ts: ev.ts, score, nodes });
  }
  return shifts;
}

function worstWindow(shifts: Shift[]): { score: number; shifts: Shift[] } {
  let bestScore = 0;
  let bestStart = 0;
  let bestEnd = -1;
  let start = 0;
  let sum = 0;
  for (const [i, shift] of shifts.entries()) {
    if (i > start && (shift.ts - shifts[i - 1]!.ts > SHIFT_GAP_US || shift.ts - shifts[start]!.ts > SHIFT_WINDOW_US)) {
      start = i;
      sum = 0;
    }
    sum += shift.score;
    if (sum > bestScore) {
      bestScore = sum;
      bestStart = start;
      bestEnd = i;
    }
  }
  return { score: bestScore, shifts: shifts.slice(bestStart, bestEnd + 1) };
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

function clsInsight(model: Model, shifts: Shift[], window: { score: number; shifts: Shift[] }): Insight | null {
  if (!shifts.length) return null;
  const rating = rate(window.score, THRESHOLDS.cls);
  const top = [...window.shifts].sort((a, b) => b.score - a.score).slice(0, MAX_LISTED);
  const culprits = top.map((shift) => ({
    atMs: rel(model, shift.ts),
    score: round4(shift.score),
    nodeIds: shift.nodes,
    likelyCauses: [...model.requests.values()]
      .filter((row) => row.finishTs !== null && row.finishTs <= shift.ts && shift.ts - row.finishTs <= CULPRIT_WINDOW_US && /font|image/i.test(row.mimeType ?? ""))
      .slice(0, 3)
      .map((row) => ({ kind: /font/i.test(row.mimeType ?? "") ? "web-font" : "image", url: row.url })),
  }));
  return {
    id: "cls-culprits",
    title: "Layout shift culprits",
    rating,
    summary: `CLS ${round4(window.score)} from ${window.shifts.length} shift${window.shifts.length === 1 ? "" : "s"} in its worst window. Give images and embeds explicit sizes, reserve space for late content, and use font-display with matched fallback metrics.`,
    savingsMs: null,
    details: { windowStartMs: window.shifts[0] ? rel(model, window.shifts[0].ts) : null, culprits },
  };
}

type Interaction = { id: number; type: string | null; ts: number; durationMs: number; inputDelayMs: number | null; processingMs: number | null; presentationMs: number | null; nodeId: number | null };

function interactionsOf(model: Model): Interaction[] {
  const byId = new Map<number, Interaction>();
  for (const ev of model.events) {
    if (ev.name !== "EventTiming" || (ev.ph !== "b" && ev.ph !== "X") || ev.ts < model.origin) continue;
    if (model.mainPid !== null && ev.pid !== model.mainPid) continue;
    const data = ev.args.data;
    const frame = text(field(data, "frame"), 256);
    if (frame && model.mainFrame && frame !== model.mainFrame) continue;
    const id = num(field(data, "interactionId"));
    const duration = num(field(data, "duration"));
    if (id === null || id <= 0 || duration === null || duration < 0) continue;
    const stamp = num(field(data, "timeStamp"));
    const start = num(field(data, "processingStart"));
    const end = num(field(data, "processingEnd"));
    const parts = stamp !== null && start !== null && end !== null && start >= stamp && end >= start;
    const entry: Interaction = {
      id,
      type: text(field(data, "type"), 64),
      ts: ev.ts,
      durationMs: duration,
      inputDelayMs: parts ? Math.round((start! - stamp!) * 10) / 10 : null,
      processingMs: parts ? Math.round((end! - start!) * 10) / 10 : null,
      presentationMs: parts ? Math.max(0, Math.round((stamp! + duration - end!) * 10) / 10) : null,
      nodeId: num(field(data, "nodeId")),
    };
    const known = byId.get(id);
    if (!known || entry.durationMs > known.durationMs) byId.set(id, entry);
  }
  return [...byId.values()];
}

function inpOf(interactions: Interaction[]): Interaction | null {
  if (!interactions.length) return null;
  const sorted = [...interactions].sort((a, b) => b.durationMs - a.durationMs);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length / 50))]!;
}

function inpInsight(model: Model, inp: Interaction | null, count: number): Insight | null {
  if (!inp) return null;
  const rating = rate(inp.durationMs, THRESHOLDS.inp);
  const phases = { inputDelayMs: inp.inputDelayMs, processingMs: inp.processingMs, presentationMs: inp.presentationMs };
  const largest = Object.entries(phases).filter(([, v]) => v !== null).sort((a, b) => (b[1] as number) - (a[1] as number))[0]?.[0] ?? null;
  const advice: Record<string, string> = {
    inputDelayMs: "Other main-thread work delayed the handler: break up long tasks running when people interact.",
    processingMs: "The event handlers themselves are slow: do less work in them or yield before non-urgent work.",
    presentationMs: "Rendering the next frame is slow: reduce DOM size, layout and style work caused by the update.",
  };
  return {
    id: "inp-breakdown",
    title: "Interaction to Next Paint breakdown",
    rating,
    summary: `INP ${inp.durationMs} ms (${inp.type ?? "interaction"}, ${count} interaction${count === 1 ? "" : "s"}). ${largest ? advice[largest] : ""}`.trim(),
    savingsMs: rating === "good" ? 0 : Math.max(0, inp.durationMs - THRESHOLDS.inp[0]),
    details: { interaction: { type: inp.type, atMs: rel(model, inp.ts), nodeId: inp.nodeId, durationMs: inp.durationMs }, phases },
  };
}

const ATTRIBUTABLE = new Set(["EvaluateScript", "v8.compile", "v8.evaluateModule", "FunctionCall", "TimerFire", "EventDispatch", "FireAnimationFrame", "ParseHTML", "Layout", "UpdateLayoutTree", "Paint", "XHRReadyStateChange", "RunMicrotasks"]);

function longTasksOf(model: Model): Ev[] {
  const onMain = (ev: Ev) => (model.mainThreads.size ? model.mainThreads.has(`${ev.pid}:${ev.tid}`) : true) && (model.mainPid === null || ev.pid === model.mainPid);
  return model.events.filter((ev) => ev.ph === "X" && ev.ts >= model.origin && (ev.name === "RunTask" || ev.name === "ThreadControllerImpl::RunTask") && ev.dur > LONG_TASK_US && onMain(ev));
}

function attribution(model: Model, task: Ev) {
  let best: Ev | null = null;
  for (const ev of model.events) {
    if (ev.ts > task.ts + task.dur) break;
    if (ev.ts < task.ts || ev.pid !== task.pid || ev.tid !== task.tid || !ATTRIBUTABLE.has(ev.name)) continue;
    if (!best || ev.dur > best.dur) best = ev;
  }
  if (!best) return null;
  const data = best.args.data;
  return { activity: best.name, url: text(field(data, "url")), functionName: text(field(data, "functionName"), 256), durationMs: ms(best.dur) };
}

function longTaskInsight(model: Model, tasks: Ev[], fcp: Ev | null): { insight: Insight | null; tbt: number | null } {
  const from = fcp?.ts ?? model.origin;
  const tbt = tasks.reduce((sum, task) => {
    const clipped = Math.min(task.ts + task.dur, model.end) - Math.max(task.ts, from);
    return sum + Math.max(0, clipped - LONG_TASK_US);
  }, 0);
  if (!tasks.length) return { insight: null, tbt: model.events.length ? 0 : null };
  const top = [...tasks].sort((a, b) => b.dur - a.dur).slice(0, MAX_LISTED);
  const rating = rate(ms(tbt), THRESHOLDS.tbt);
  return {
    tbt,
    insight: {
      id: "long-tasks",
      title: "Long main-thread tasks",
      rating,
      summary: `${tasks.length} task${tasks.length === 1 ? "" : "s"} over 50 ms; ${ms(tbt)} ms total blocking time after first paint. Split work into smaller chunks, defer non-critical scripts and move heavy work off the main thread.`,
      savingsMs: ms(tbt),
      details: { tasks: top.map((task) => ({ startMs: rel(model, task.ts), durationMs: ms(task.dur), attribution: attribution(model, task) })) },
    },
  };
}

const BLOCKING = new Set(["blocking", "in_body_parser_blocking"]);

function blockedSpan(rows: RequestRow[], from: number, limit: number): number {
  const spans = rows
    .map((row): [number, number] => [Math.max(row.sendTs, from), Math.min(row.finishTs ?? limit, limit)])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let reach = -Infinity;
  for (const [start, end] of spans) {
    if (end <= reach) continue;
    total += end - Math.max(start, reach);
    reach = end;
  }
  return total;
}

function renderBlockingInsight(model: Model, fcp: Ev | null, doc: RequestRow | null): Insight | null {
  const limit = fcp?.ts ?? model.end;
  const rows = [...model.requests.values()].filter((row) => row.renderBlocking !== null && BLOCKING.has(row.renderBlocking) && row.sendTs <= limit && row !== doc);
  if (!rows.length) return null;
  const savings = blockedSpan(rows, doc?.headersEndTs ?? model.origin, limit);
  const rating: Rating = ms(savings) >= 300 ? "poor" : ms(savings) >= 100 ? "needs-improvement" : "good";
  return {
    id: "render-blocking",
    title: "Render-blocking requests",
    rating,
    summary: `${rows.length} request${rows.length === 1 ? " blocks" : "s block"} the first paint for ${ms(savings)} ms. Inline critical CSS, defer or async scripts, and load the rest later.`,
    savingsMs: ms(savings),
    details: { requests: rows.sort((a, b) => (b.finishTs ?? limit) - b.sendTs - ((a.finishTs ?? limit) - a.sendTs)).slice(0, MAX_LISTED).map((row) => requestDetail(model, row)) },
  };
}

function documentInsight(model: Model, doc: RequestRow | null): Insight | null {
  if (!doc || doc.headersEndTs === null) return null;
  const ttfb = Math.max(0, doc.headersEndTs - model.origin);
  const rating = rate(ms(ttfb), THRESHOLDS.ttfb);
  const redirected = doc.status !== null && doc.status >= 300 && doc.status < 400;
  return {
    id: "document-latency",
    title: "Document request latency",
    rating,
    summary: `The server sent the document's first byte after ${ms(ttfb)} ms${redirected ? " and answered with a redirect" : ""}. ${rating === "good" ? "" : "Cache the HTML at the edge, avoid redirects, and speed up server work."}`.trim(),
    savingsMs: rating === "good" ? 0 : ms(Math.max(0, ttfb - THRESHOLDS.ttfb[0] * 1000)),
    details: { request: requestDetail(model, doc), ttfbMs: ms(ttfb), redirected },
  };
}

function networkInsight(model: Model, lcp: Lcp | null): Insight | null {
  const limit = lcp?.ts ?? model.end;
  const rows = [...model.requests.values()].filter((row) => row.sendTs <= limit && row.finishTs !== null);
  if (!rows.length) return null;
  const slow = rows.filter((row) => row.finishTs! - row.sendTs >= 1_000_000);
  const large = rows.filter((row) => (row.encodedBytes ?? 0) >= 500_000);
  const failed = rows.filter((row) => row.failed || (row.status ?? 0) >= 400);
  const top = [...rows].sort((a, b) => b.finishTs! - b.sendTs - (a.finishTs! - a.sendTs)).slice(0, MAX_LISTED);
  const rating: Rating = slow.length + large.length + failed.length === 0 ? "good" : slow.length > 2 || large.length > 2 || failed.length > 0 ? "poor" : "needs-improvement";
  return {
    id: "network-bottlenecks",
    title: "Network bottlenecks before LCP",
    rating,
    summary: `${rows.length} request${rows.length === 1 ? "" : "s"} before LCP: ${slow.length} took over a second, ${large.length} were over 500 KB, ${failed.length} failed.`,
    savingsMs: null,
    details: { slowest: top.map((row) => requestDetail(model, row)), slowCount: slow.length, largeCount: large.length, failedCount: failed.length },
  };
}

export function analyzeTrace(input: unknown): TraceInsights {
  const { events: raw, truncated } = traceEventsOf(input);
  const model = buildModel(raw);
  const fcp = fcpOf(model);
  const lcp = lcpOf(model);
  const doc = documentRequest(model);
  const shifts = shiftsOf(model);
  const window = worstWindow(shifts);
  const interactions = interactionsOf(model);
  const inp = inpOf(interactions);
  const tasks = longTasksOf(model);
  const { insight: longTasks, tbt } = longTaskInsight(model, tasks, fcp);
  const insights = [lcpInsight(model, lcp, doc), clsInsight(model, shifts, window), inpInsight(model, inp, interactions.length), longTasks, renderBlockingInsight(model, fcp, doc), documentInsight(model, doc), networkInsight(model, lcp)].filter((i): i is Insight => i !== null);
  const order: Rating[] = ["poor", "needs-improvement", "good"];
  insights.sort((a, b) => order.indexOf(a.rating) - order.indexOf(b.rating));
  return {
    navigation: model.navigation ? { url: model.navigation.url, navigationId: model.navigation.navigationId } : null,
    metrics: {
      fcp: fcp ? metric(fcp.ts - model.origin, THRESHOLDS.fcp) : null,
      lcp: lcp ? metric(lcp.ts - model.origin, THRESHOLDS.lcp) : null,
      ttfb: doc?.headersEndTs != null ? metric(doc.headersEndTs - model.origin, THRESHOLDS.ttfb) : null,
      tbt: tbt === null ? null : metric(tbt, THRESHOLDS.tbt),
      inp: inp ? { ms: inp.durationMs, rating: rate(inp.durationMs, THRESHOLDS.inp) } : null,
      cls: { value: round4(window.score), rating: rate(window.score, THRESHOLDS.cls) },
    },
    insights,
    counts: { events: model.events.length, requests: model.requests.size, layoutShifts: shifts.length, interactions: interactions.length, longTasks: tasks.length },
    truncated,
  };
}

export const overallRating = (result: TraceInsights): Rating => {
  const { fcp, lcp, ttfb, tbt, inp, cls } = result.metrics;
  const measured = [fcp, lcp, ttfb, tbt, inp].flatMap((metric) => (metric ? [metric.rating] : []));
  return worst([...result.insights.map((i) => i.rating), ...measured, ...(result.counts.layoutShifts ? [cls.rating] : [])]);
};
