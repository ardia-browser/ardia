export const WORLD_PREFIX = "ardia-plugin:";
export const STYLE_WORLD = "ardia-plugin-styles";
export const MAX_WORLD_MESSAGE = 256 * 1024;
export const MAX_WORLD_OUTBOX = 64;
export const MAX_WORLD_EVENT = MAX_WORLD_MESSAGE * MAX_WORLD_OUTBOX + 1024;

const WORLD_KEY = /^[a-z0-9][a-z0-9-]{0,39}(?:__[a-z0-9][a-z0-9-]{0,39})?$/;
const UNIT_ID = /^[A-Za-z0-9_-]{1,40}$/;
const TOKEN = /^[A-Za-z0-9_-]{8,80}$/;

export const worldOf = (plugin: string, scriptId?: string): string | null =>
  WORLD_KEY.test(plugin) && (scriptId === undefined || UNIT_ID.test(scriptId)) ? `${WORLD_PREFIX}${plugin}${scriptId === undefined ? "" : `~${scriptId}`}` : null;

export function unitOfWorld(world: string): { plugin: string; scriptId: string | null } | null {
  if (!world.startsWith(WORLD_PREFIX)) return null;
  const [plugin = "", scriptId, ...rest] = world.slice(WORLD_PREFIX.length).split("~");
  if (rest.length || !WORLD_KEY.test(plugin) || (scriptId !== undefined && !UNIT_ID.test(scriptId))) return null;
  return { plugin, scriptId: scriptId ?? null };
}

export const pluginOfWorld = (world: string): string | null => unitOfWorld(world)?.plugin ?? null;

export const isWorldToken = (token: unknown): token is string => typeof token === "string" && TOKEN.test(token);

export type WorldScript = { id: string; code: string };

const literal = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const pageAt = (href: string) => `(String(location.href).split("#")[0] === ${literal(href.split("#")[0])})`;

export function worldBootstrap(world: string, transport: "webkit" | "poll", token: string, href: string, document: string): string {
  return `(() => {
  if (!${pageAt(href)}) return "";
  const prior = globalThis.__ardiaWorld;
  if (prior && prior.doc === ${literal(token)}) return prior.doc;
  if (prior) prior.teardown(prior.doc);
  const world = ${literal(world)};
  const doc = ${literal(token)};
  const native = ${literal(document)};
  const max = ${MAX_WORLD_MESSAGE};
  const outbox = [];
  let waiting = null;
  let disposed = false;
  const listeners = new Set();
  const handler = ${transport === "webkit" ? "globalThis.webkit && globalThis.webkit.messageHandlers && globalThis.webkit.messageHandlers.ardiaPluginWorld" : "null"};
  const reals = prior ? prior.reals : Object.freeze({
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    frame: globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame.bind(globalThis) : null,
    cancelFrame: globalThis.cancelAnimationFrame ? globalThis.cancelAnimationFrame.bind(globalThis) : null,
    Observer: globalThis.MutationObserver || null,
    add: EventTarget.prototype.addEventListener,
    remove: EventTarget.prototype.removeEventListener,
  });
  const realSetTimeout = reals.setTimeout;
  const realClearTimeout = reals.clearTimeout;
  const realSetInterval = reals.setInterval;
  const realClearInterval = reals.clearInterval;
  const realFrame = reals.frame;
  const realCancelFrame = reals.cancelFrame;
  const timeouts = new Set();
  const intervals = new Set();
  const frames = new Set();
  const observers = new Set();
  const added = [];
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (disposed || typeof fn !== "function") return 0;
    const id = realSetTimeout(() => { timeouts.delete(id); if (!disposed) fn(...args); }, ms);
    timeouts.add(id);
    return id;
  };
  globalThis.clearTimeout = (id) => { timeouts.delete(id); realClearTimeout(id); };
  globalThis.setInterval = (fn, ms, ...args) => {
    if (disposed || typeof fn !== "function") return 0;
    const id = realSetInterval(() => { if (!disposed) fn(...args); }, ms);
    intervals.add(id);
    return id;
  };
  globalThis.clearInterval = (id) => { intervals.delete(id); realClearInterval(id); };
  if (realFrame) {
    globalThis.requestAnimationFrame = (fn) => {
      if (disposed) return 0;
      const id = realFrame((t) => { frames.delete(id); if (!disposed) fn(t); });
      frames.add(id);
      return id;
    };
    globalThis.cancelAnimationFrame = (id) => { frames.delete(id); realCancelFrame(id); };
  }
  const RealObserver = reals.Observer;
  if (RealObserver) {
    globalThis.MutationObserver = class extends RealObserver {
      constructor(fn) { super((records, observer) => { if (!disposed) fn(records, observer); }); observers.add(this); }
    };
  }
  const realAdd = reals.add;
  const realRemove = reals.remove;
  EventTarget.prototype.addEventListener = function (type, fn, options) {
    if (disposed || !fn) return;
    const wrapped = typeof fn === "function" ? function (event) { if (!disposed) return fn.call(this, event); } : { handleEvent: (event) => { if (!disposed) fn.handleEvent(event); } };
    added.push([this, type, fn, wrapped, options]);
    return realAdd.call(this, type, wrapped, options);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, options) {
    const at = added.findIndex((e) => e[0] === this && e[1] === type && e[2] === fn);
    if (at < 0) return realRemove.call(this, type, fn, options);
    const [entry] = added.splice(at, 1);
    return realRemove.call(this, type, entry[3], options);
  };
  const flush = () => {
    if (!waiting || !outbox.length) return;
    const resolve = waiting;
    waiting = null;
    resolve(JSON.stringify(outbox.splice(0)));
  };
  const send = (scriptId, message) => {
    if (disposed) throw new Error("ardia.bridge is closed");
    let json;
    try { json = JSON.stringify({ doc, scriptId, message: message === undefined ? null : message }); } catch { throw new TypeError("ardia.bridge.send takes JSON"); }
    if (json.length > max) throw new RangeError("ardia.bridge.send takes up to 256 KB");
    if (handler) { handler.postMessage({ world, json }); return; }
    if (outbox.length >= ${MAX_WORLD_OUTBOX}) throw new RangeError("ardia.bridge has too many messages waiting");
    outbox.push(json);
    flush();
  };
  const take = () => disposed ? Promise.resolve(null) : outbox.length ? Promise.resolve(JSON.stringify(outbox.splice(0))) : new Promise((resolve) => { waiting = resolve; realSetTimeout(() => { if (waiting === resolve) { waiting = null; resolve("[]"); } }, 20000); });
  const deliver = (given, json, href) => {
    if (disposed || given !== doc || typeof json !== "string" || json.length > max) return false;
    if (typeof href === "string" && String(location.href).split("#")[0] !== href.split("#")[0]) return false;
    let parsed;
    try { parsed = JSON.parse(json); } catch { return false; }
    for (const listener of [...listeners]) { if (parsed.scriptId && listener.scriptId && parsed.scriptId !== listener.scriptId) continue; try { listener.fn(parsed.message); } catch (error) { console.error(error); } }
    return true;
  };
  const teardown = (given) => {
    if (given !== doc) return false;
    disposed = true;
    listeners.clear();
    for (const id of timeouts) realClearTimeout(id);
    for (const id of intervals) realClearInterval(id);
    for (const id of frames) realCancelFrame && realCancelFrame(id);
    for (const observer of observers) observer.disconnect();
    for (const [target, type, , wrapped, options] of added.splice(0)) realRemove.call(target, type, wrapped, options);
    timeouts.clear(); intervals.clear(); frames.clear(); observers.clear();
    if (waiting) { const resolve = waiting; waiting = null; resolve(null); }
    for (const node of document.querySelectorAll("[data-ardia-world]")) if (node.getAttribute("data-ardia-world") === world) node.remove();
    return true;
  };
  const bridgeFor = (scriptId) => Object.freeze({
    send: (message) => send(scriptId, message),
    onMessage: (fn) => { if (typeof fn !== "function") throw new TypeError("onMessage needs a function"); if (disposed) return () => false; const entry = { scriptId, fn }; listeners.add(entry); return () => listeners.delete(entry); },
  });
  globalThis.__ardiaWorld = Object.freeze({ doc, native, reals, take, deliver, teardown, bridgeFor, alive: () => !disposed });
  return doc;
})()`;
}

export function worldScript(script: WorldScript, token: string, href: string): string {
  return `(() => {
  const host = globalThis.__ardiaWorld;
  if (!host || host.doc !== ${literal(token)} || !host.alive() || !${pageAt(href)}) return false;
  const ardia = Object.freeze({ bridge: host.bridgeFor(${literal(script.id)}) });
  try { (function (ardia) {
${script.code}
}).call(undefined, ardia); } catch (error) { console.error(error); }
  return true;
})()`;
}

export function worldStyles(world: string, sheets: { id: string; css: string }[], href: string | null): string {
  return `(() => {
  ${href === null ? "" : `if (!${pageAt(href)}) return false;`}
  const world = ${literal(world)};
  const sheets = ${literal(sheets)};
  for (const node of document.querySelectorAll("style[data-ardia-world]")) if (node.getAttribute("data-ardia-world") === world) node.remove();
  const root = document.head || document.documentElement;
  if (!root) return false;
  for (const sheet of sheets) {
    const style = document.createElement("style");
    style.setAttribute("data-ardia-world", world);
    style.setAttribute("data-ardia-sheet", sheet.id);
    style.textContent = sheet.css;
    root.appendChild(style);
  }
  return true;
})()`;
}

export const worldDeliver = (token: string, json: string, href: string) => `globalThis.__ardiaWorld ? globalThis.__ardiaWorld.deliver(${literal(token)}, ${literal(json)}, ${literal(href)}) : false`;

export const WORLD_TAKE = "globalThis.__ardiaWorld ? globalThis.__ardiaWorld.take() : Promise.resolve(null)";

export const worldTeardown = (token: string) => `globalThis.__ardiaWorld ? globalThis.__ardiaWorld.teardown(${literal(token)}) : false`;

export type WorldMessage = { doc: string | null; scriptId: string | null; message: unknown };

export function worldMessagesOf(json: unknown): WorldMessage[] {
  if (typeof json !== "string" || json.length > MAX_WORLD_EVENT) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.slice(0, MAX_WORLD_OUTBOX).flatMap((item) => {
    if (typeof item === "string" && item.length > MAX_WORLD_MESSAGE) return [];
    const entry = typeof item === "string" ? safeParse(item) : item;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    if (typeof item !== "string" && JSON.stringify(entry).length > MAX_WORLD_MESSAGE) return [];
    const record = entry as Record<string, unknown>;
    return [{ doc: isWorldToken(record.doc) ? record.doc : null, scriptId: typeof record.scriptId === "string" && record.scriptId.length <= 64 ? record.scriptId : null, message: record.message ?? null }];
  });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
