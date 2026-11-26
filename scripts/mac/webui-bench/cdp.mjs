#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HELP = `A small DevTools client for the WebUI shell (chrome://ardia).

  node scripts/mac/webui-bench/cdp.mjs <port> eval '<expression>'   evaluate in the shell, print JSON
  node scripts/mac/webui-bench/cdp.mjs <port> shot <file.png>        screenshot the shell document

Every call has a deadline; a dead socket rejects every pending call at once.`;

export const isShell = (t) => t.type === "page" && String(t.url).startsWith("chrome://ardia");

export async function shellTarget(port, match = isShell, timeoutMs = 5000) {
  const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(timeoutMs) });
  const targets = await response.json();
  const target = targets.find(match);
  if (!target) throw new Error(`no shell target on port ${port}`);
  return target;
}

export function openSocket(url, { timeoutMs = 15000, Socket = WebSocket } = {}) {
  const socket = new Socket(url);
  return new Promise((resolve, reject) => {
    const fail = (message) => {
      clearTimeout(timer);
      try { socket.close(); } catch {}
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail(`DevTools socket ${url} did not open in ${timeoutMs} ms`), timeoutMs);
    socket.onopen = () => (clearTimeout(timer), resolve(socket));
    socket.onerror = () => fail(`DevTools socket ${url} failed`);
  });
}

export async function connect(port, { match = isShell, timeoutMs = 15000 } = {}) {
  const target = await shellTarget(port, match);
  const socket = await openSocket(target.webSocketDebuggerUrl, { timeoutMs });
  let next = 0;
  const pending = new Map();
  const listeners = new Set();
  const failAll = (error) => {
    for (const { reject, timer } of pending.values()) clearTimeout(timer), reject(error);
    pending.clear();
  };
  socket.onclose = () => failAll(new Error(`DevTools socket on ${port} closed`));
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject, timer } = pending.get(data.id);
      pending.delete(data.id);
      clearTimeout(timer);
      data.error ? reject(new Error(data.error.message)) : resolve(data.result);
    } else if (data.method) for (const listener of listeners) listener(data);
  };
  const send = (method, params = {}, { timeout = timeoutMs } = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeout} ms`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression, options) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, options);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const on = (listener) => (listeners.add(listener), () => listeners.delete(listener));
  const close = () => {
    failAll(new Error("closed"));
    try { socket.close(); } catch {}
  };
  return { send, evaluate, on, close };
}

export const TRACE_CATEGORIES = [
  "disabled-by-default-devtools.screenshot",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "blink.user_timing",
  "cc",
  "benchmark",
  "input",
];

export async function traced(cdp, action, { categories = TRACE_CATEGORIES, tailMs = 1500, warmupMs = 300, timeoutMs = 30000 } = {}) {
  const events = [];
  let finish;
  let dataLoss = false;
  const complete = new Promise((resolve) => (finish = resolve));
  const off = cdp.on((m) => {
    if (m.method === "Tracing.dataCollected") events.push(...m.params.value);
    else if (m.method === "Tracing.tracingComplete") {
      dataLoss = m.params?.dataLossOccurred === true;
      finish();
    }
  });
  let started = false;
  let ended = false;
  let timer;
  try {
    await cdp.send("Tracing.start", { traceConfig: { includedCategories: categories, recordMode: "recordAsMuchAsPossible" }, transferMode: "ReportEvents" });
    started = true;
    await new Promise((r) => setTimeout(r, warmupMs));
    const value = await action();
    await new Promise((r) => setTimeout(r, tailMs));
    ended = true;
    await cdp.send("Tracing.end");
    await Promise.race([complete, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("trace did not complete")), timeoutMs)))]);
    return { value, events, dataLoss };
  } finally {
    clearTimeout(timer);
    if (started && !ended) await cdp.send("Tracing.end").catch(() => {});
    off();
  }
}

export function assertTraceComplete(trace, label = "trace") {
  if (trace.dataLoss) throw new Error(`the ${label} trace lost data (Tracing.tracingComplete dataLossOccurred), so its frames are incomplete`);
  return trace;
}

export function screenshotsOf(events) {
  return events.filter((e) => e.name === "Screenshot" && e.args?.snapshot).sort((a, b) => a.ts - b.ts);
}

export function marksOf(events, prefix) {
  return events.filter((e) => String(e.cat).includes("blink.user_timing") && String(e.name).startsWith(prefix)).sort((a, b) => a.ts - b.ts);
}

export function epochOffset(events, syncName, syncEpochMs) {
  const mark = marksOf(events, syncName)[0];
  return mark ? syncEpochMs - mark.ts / 1000 : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [port, op, arg] = process.argv.slice(2);
  if (!port || !op || port === "-h" || port === "--help") {
    console.log(HELP);
    process.exit(port === "-h" || port === "--help" ? 0 : 64);
  }
  const cdp = await connect(port);
  try {
    if (op === "eval") console.log(JSON.stringify(await cdp.evaluate(arg), null, 1));
    else if (op === "shot") {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(arg, Buffer.from(data, "base64"));
      console.log(arg);
    } else {
      console.error(`unknown op ${op}`);
      process.exitCode = 64;
    }
  } finally {
    cdp.close();
  }
}
