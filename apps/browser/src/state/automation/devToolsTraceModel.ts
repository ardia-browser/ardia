export const MAX_TRACE_EVENTS = 1_000_000;
const MAX_URL = 2048;
const NAVIGATION_SLACK_US = 1_000;

export type Fields = Record<string, unknown>;
export type Ev = { name: string; ph: string; ts: number; dur: number; pid: number; tid: number; args: Fields };

export type RequestRow = {
  requestId: string;
  url: string;
  priority: string | null;
  renderBlocking: string | null;
  mimeType: string | null;
  status: number | null;
  sendTs: number;
  headersEndTs: number | null;
  finishTs: number | null;
  encodedBytes: number | null;
  failed: boolean;
};


export const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
export const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
export const text = (value: unknown, max = MAX_URL): string | null => (typeof value === "string" ? (value.length > max ? value.slice(0, max) : value) : null);
export const field = (value: unknown, key: string): unknown => (isFields(value) && Object.hasOwn(value, key) ? value[key] : undefined);
export const ms = (us: number) => Math.round(us / 100) / 10;
export const withoutFragment = (url: string) => url.split("#")[0]!;

export function normalized(raw: unknown): Ev | null {
  if (!isFields(raw)) return null;
  const name = text(raw.name, 256);
  const ts = num(raw.ts);
  if (!name || ts === null) return null;
  return { name, ph: text(raw.ph, 4) ?? "", ts, dur: Math.max(0, num(raw.dur) ?? 0), pid: num(raw.pid) ?? 0, tid: num(raw.tid) ?? 0, args: isFields(raw.args) ? raw.args : {} };
}

export function traceEventsOf(input: unknown): { events: unknown[]; truncated: boolean } {
  const list = Array.isArray(input) ? input : Array.isArray(field(input, "traceEvents")) ? (field(input, "traceEvents") as unknown[]) : [];
  return list.length > MAX_TRACE_EVENTS ? { events: list.slice(0, MAX_TRACE_EVENTS), truncated: true } : { events: list, truncated: false };
}

export type Model = {
  events: Ev[];
  mainThreads: Set<string>;
  mainFrame: string | null;
  mainPid: number | null;
  targetFrames: Set<string>;
  navigation: { ts: number; url: string; navigationId: string | null } | null;
  origin: number;
  end: number;
  requests: Map<string, RequestRow>;
};

export function frameOf(ev: Ev): string | null {
  return text(ev.args.frame, 256) ?? text(field(ev.args.data, "frame"), 256);
}

function inMainFrame(ev: Ev, mainFrame: string | null): boolean {
  const data = ev.args.data;
  if (mainFrame !== null) return frameOf(ev) === mainFrame;
  return field(data, "isOutermostMainFrame") === true || field(data, "isLoadingMainFrame") === true;
}

function isMainNavigation(ev: Ev, mainFrame: string | null): boolean {
  const url = text(field(ev.args.data, "documentLoaderURL"));
  return !!url && /^https?:/i.test(url) && inMainFrame(ev, mainFrame);
}

function targetFramesOf(events: Ev[], mainFrame: string | null): Set<string> {
  const frames = new Set<string>();
  if (mainFrame === null) return frames;
  const children = new Map<string, Set<string>>();
  const link = (id: string | null, parent: string | null) => {
    if (!id || !parent) return;
    const set = children.get(parent) ?? new Set<string>();
    set.add(id);
    children.set(parent, set);
  };
  for (const ev of events) {
    const data = ev.args.data;
    if (ev.name === "TracingStartedInBrowser") for (const frame of Array.isArray(field(data, "frames")) ? (field(data, "frames") as unknown[]) : []) link(text(field(frame, "frame"), 256), text(field(frame, "parent"), 256));
    if (ev.name === "FrameCommittedInBrowser") link(text(field(data, "frame"), 256), text(field(data, "parent"), 256));
  }
  const queue = [mainFrame];
  while (queue.length) {
    const frame = queue.pop()!;
    if (frames.has(frame)) continue;
    frames.add(frame);
    for (const child of children.get(frame) ?? []) queue.push(child);
  }
  return frames;
}

export function buildModel(raw: unknown[]): Model {
  let events: Ev[] = [];
  for (const item of raw) {
    const ev = normalized(item);
    if (ev) events.push(ev);
  }
  events.sort((a, b) => a.ts - b.ts);
  const mainThreads = new Set<string>();
  let mainFrame: string | null = null;
  let mainPid: number | null = null;
  for (const ev of events) {
    if (ev.ph === "M" && ev.name === "thread_name" && field(ev.args, "name") === "CrRendererMain") mainThreads.add(`${ev.pid}:${ev.tid}`);
    if (ev.name === "TracingStartedInBrowser" && mainFrame === null) {
      const frames = field(ev.args.data, "frames");
      const top = Array.isArray(frames) ? frames.find((f) => isFields(f) && (f.isOutermostMainFrame === true || (f.parent === undefined && f.isOutermostMainFrame === undefined))) : undefined;
      mainFrame = text(field(top, "frame"), 256);
      mainPid = num(field(top, "processId"));
    }
  }
  let navigation: Model["navigation"] = null;
  for (const ev of events) {
    if (ev.name !== "navigationStart") continue;
    const data = ev.args.data;
    const url = text(field(data, "documentLoaderURL"));
    if (!isMainNavigation(ev, mainFrame) || !url || !/^https?:/i.test(url)) continue;
    navigation = { ts: ev.ts, url, navigationId: text(field(data, "navigationId"), 256) };
    if (mainFrame === null) mainFrame = frameOf(ev);
    mainPid = ev.pid;
    break;
  }
  const targetFrames = targetFramesOf(events, mainFrame);
  if (navigation) {
    const startedAt = navigation.ts;
    const next = events.find((ev) => ev.name === "navigationStart" && ev.ts > startedAt && inMainFrame(ev, mainFrame));
    const from = startedAt - NAVIGATION_SLACK_US;
    const until = next ? next.ts : Infinity;
    const kept: Ev[] = [];
    for (const ev of events) {
      if (ev.ph === "M") kept.push(ev);
      else if (ev.ts >= from && ev.ts < until) kept.push(ev.ts + ev.dur > until ? { ...ev, dur: until - ev.ts } : ev);
    }
    events = kept;
  }
  const first = events.find((ev) => ev.ph !== "M");
  const origin = navigation?.ts ?? first?.ts ?? 0;
  const end = events.reduce((latest, ev) => Math.max(latest, ev.ts + ev.dur), origin);
  return { events, mainThreads, mainFrame, mainPid, targetFrames, navigation, origin, end, requests: requestsOf(events, targetFrames) };
}

export function requestsOf(events: Ev[], targetFrames: ReadonlySet<string> = new Set()): Map<string, RequestRow> {
  const requests = new Map<string, RequestRow>();
  for (const ev of events) {
    const data = ev.args.data;
    const requestId = text(field(data, "requestId"), 256);
    if (!requestId) continue;
    if (ev.name === "ResourceSendRequest") {
      const url = text(field(data, "url"));
      if (!url) continue;
      const hop = requests.get(requestId);
      if (hop) {
        hop.url = url;
        continue;
      }
      const frame = text(field(data, "frame"), 256);
      if (targetFrames.size && (frame === null || !targetFrames.has(frame))) continue;
      requests.set(requestId, {
        requestId,
        url,
        priority: text(field(data, "priority"), 32),
        renderBlocking: text(field(data, "renderBlocking"), 64),
        mimeType: null,
        status: null,
        sendTs: ev.ts,
        headersEndTs: null,
        finishTs: null,
        encodedBytes: null,
        failed: false,
      });
      continue;
    }
    const row = requests.get(requestId);
    if (!row) continue;
    if (ev.name === "ResourceReceiveResponse") {
      row.status = num(field(data, "statusCode"));
      row.mimeType = text(field(data, "mimeType"), 128);
      const timing = field(data, "timing");
      const requestTime = num(field(timing, "requestTime"));
      const headersEnd = num(field(timing, "receiveHeadersEnd"));
      row.headersEndTs = requestTime !== null && headersEnd !== null && headersEnd >= 0 ? (requestTime * 1000 + headersEnd) * 1000 : ev.ts;
    } else if (ev.name === "ResourceFinish") {
      const finishTime = num(field(data, "finishTime"));
      row.finishTs = finishTime !== null && finishTime > 0 ? finishTime * 1_000_000 : ev.ts;
      row.encodedBytes = num(field(data, "encodedDataLength"));
      row.failed = field(data, "didFail") === true;
    }
  }
  return requests;
}

export const forNavigation = (model: Model, ev: Ev) => {
  const navId = text(field(ev.args.data, "navigationId"), 256);
  if (model.navigation?.navigationId && navId) return navId === model.navigation.navigationId;
  if (model.mainFrame) return frameOf(ev) === model.mainFrame || field(ev.args.data, "isOutermostMainFrame") === true;
  return true;
};

export function fcpOf(model: Model): Ev | null {
  return model.events.find((ev) => ev.name === "firstContentfulPaint" && ev.ts >= model.origin && forNavigation(model, ev)) ?? null;
}

export type Lcp = { ts: number; nodeId: number | null; type: string | null; size: number | null; url: string | null };

const inRenderer = (model: Model, ev: Ev) => (model.mainPid === null || ev.pid === model.mainPid) && (model.mainFrame === null || frameOf(ev) === model.mainFrame);

export function lcpOf(model: Model): Lcp | null {
  let found: Lcp | null = null;
  let index = -1;
  const imageUrls = new Map<number, string>();
  for (const ev of model.events) {
    if (ev.name === "LargestImagePaint::Candidate" && ev.ts >= model.origin && inRenderer(model, ev)) {
      const node = num(field(ev.args.data, "DOMNodeId"));
      const url = text(field(ev.args.data, "imageUrl"));
      if (node !== null && url) imageUrls.set(node, url);
    }
    if (ev.ts < model.origin || !forNavigation(model, ev) || (model.mainPid !== null && ev.pid !== model.mainPid)) continue;
    if (ev.name === "largestContentfulPaint::Invalidate") {
      found = null;
      index = -1;
    }
    if (ev.name !== "largestContentfulPaint::Candidate") continue;
    const data = ev.args.data;
    const candidateIndex = num(field(data, "candidateIndex")) ?? index + 1;
    if (candidateIndex < index) continue;
    index = candidateIndex;
    found = { ts: ev.ts, nodeId: num(field(data, "nodeId")), type: text(field(data, "type"), 32), size: num(field(data, "size")), url: text(field(data, "url")) };
  }
  if (found && !found.url && found.nodeId !== null) found.url = imageUrls.get(found.nodeId) ?? null;
  return found;
}

export function documentRequest(model: Model): RequestRow | null {
  if (!model.navigation) return null;
  const loaderId = model.navigation.navigationId;
  if (loaderId) {
    const byLoader = model.requests.get(loaderId);
    if (byLoader) return byLoader;
  }
  const want = withoutFragment(model.navigation.url);
  let best: RequestRow | null = null;
  for (const row of model.requests.values()) if (withoutFragment(row.url) === want && row.sendTs >= model.origin - 1000 && (!best || row.sendTs < best.sendTs)) best = row;
  return best;
}
