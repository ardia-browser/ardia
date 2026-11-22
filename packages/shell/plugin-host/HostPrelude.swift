enum HostPrelude {
  static let source = #"""
(function (native) {
  "use strict";
  const g = globalThis;
  const define = (name, value) => Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false });

  class DOMException extends Error {
    constructor(message = "", name = "Error") { super(message); this.name = name; }
  }
  define("DOMException", DOMException);

  const describe = (value, seen = new WeakSet()) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack ? `${value.name}: ${value.message}\n${value.stack}` : `${value.name}: ${value.message}`;
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
    if (typeof value === "symbol" || typeof value === "bigint") return value.toString();
    if (value === null || typeof value !== "object") return String(value);
    try {
      return JSON.stringify(value, (key, inner) => {
        if (typeof inner === "bigint") return inner.toString();
        if (inner && typeof inner === "object") { if (seen.has(inner)) return "[Circular]"; seen.add(inner); }
        return inner;
      });
    } catch { return String(value); }
  };
  const reportError = (error) => native.log("error", "Uncaught " + describe(error));
  define("reportError", reportError);
  const consoleObject = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) consoleObject[level] = (...args) => native.log(level, args.map((a) => describe(a)).join(" "));
  define("console", consoleObject);

  const TOO_MANY_TIMERS = "a plugin can have at most 10000 timers waiting";
  let nextTimer = 0;
  const timers = new Map();
  native.onTimer((id) => {
    const timer = timers.get(id);
    if (!timer) return;
    timers.delete(id);
    if (timer.repeat) {
      if (native.schedule(id, timer.ms) === false) reportError(new RangeError(TOO_MANY_TIMERS + ", so an interval stopped"));
      else timers.set(id, timer);
    }
    try { timer.fn.apply(undefined, timer.args); } catch (error) { reportError(error); }
  });
  const addTimer = (fn, ms, args, repeat) => {
    if (typeof fn !== "function") throw new TypeError("a timer needs a function");
    const delay = Math.max(repeat ? 1 : 0, Number(ms) || 0);
    const id = ++nextTimer;
    if (native.schedule(id, delay) === false) throw new RangeError(TOO_MANY_TIMERS);
    timers.set(id, { fn, args, ms: delay, repeat });
    return id;
  };
  const clearTimer = (id) => {
    const key = Number(id);
    if (timers.delete(key)) native.cancel(key);
  };
  define("setTimeout", (fn, ms, ...args) => addTimer(fn, ms, args, false));
  define("setInterval", (fn, ms, ...args) => addTimer(fn, ms, args, true));
  define("clearTimeout", clearTimer);
  define("clearInterval", clearTimer);
  define("queueMicrotask", (fn) => {
    if (typeof fn !== "function") throw new TypeError("queueMicrotask needs a function");
    Promise.resolve().then(() => { try { fn(); } catch (error) { reportError(error); } });
  });

  define("btoa", (text) => {
    const out = native.btoa(String(text));
    if (out === null) throw new DOMException("btoa takes only Latin-1 characters", "InvalidCharacterError");
    return out;
  });
  define("atob", (text) => {
    const out = native.atob(String(text));
    if (out === null) throw new DOMException("atob was given text that isn't valid base64", "InvalidCharacterError");
    return out;
  });
  define("crypto", Object.freeze({
    randomUUID: () => native.randomUUID(),
    getRandomValues(array) {
      if (!ArrayBuffer.isView(array) || array instanceof DataView || array instanceof Float32Array || array instanceof Float64Array) throw new TypeError("getRandomValues takes an integer typed array");
      if (array.byteLength > 65536) throw new DOMException("getRandomValues fills at most 65536 bytes", "QuotaExceededError");
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(native.randomBytes(array.byteLength));
      return array;
    },
  }));

  const utf8Encode = (input) => {
    const s = String(input);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
      } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  };
  const bytesOf = (input) => {
    if (input === undefined || input === null) return new Uint8Array(0);
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError("expected an ArrayBuffer or a typed array");
  };
  const utf8Decode = (bytes, fatal) => {
    let out = "";
    let chunk = [];
    const emit = (cp) => { chunk.push(cp); if (chunk.length >= 8192) { out += String.fromCodePoint(...chunk); chunk = []; } };
    const fail = () => { if (fatal) throw new TypeError("The encoded data was not valid UTF-8"); return 0xfffd; };
    let need = 0, cp = 0, lower = 0x80, upper = 0xbf;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (need === 0) {
        if (b <= 0x7f) emit(b);
        else if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f; }
        else if (b >= 0xe0 && b <= 0xef) { if (b === 0xe0) lower = 0xa0; if (b === 0xed) upper = 0x9f; need = 2; cp = b & 0xf; }
        else if (b >= 0xf0 && b <= 0xf4) { if (b === 0xf0) lower = 0x90; if (b === 0xf4) upper = 0x8f; need = 3; cp = b & 7; }
        else emit(fail());
        continue;
      }
      if (b < lower || b > upper) { need = 0; cp = 0; lower = 0x80; upper = 0xbf; emit(fail()); i--; continue; }
      lower = 0x80; upper = 0xbf; cp = (cp << 6) | (b & 0x3f);
      if (--need === 0) emit(cp);
    }
    if (need) emit(fail());
    if (chunk.length) out += String.fromCodePoint(...chunk);
    return out;
  };
  class TextEncoder {
    get encoding() { return "utf-8"; }
    encode(input = "") { return utf8Encode(input); }
    encodeInto(input, dest) {
      const s = String(input);
      let read = 0, written = 0;
      while (read < s.length) {
        let c = s.charCodeAt(read), units = 1;
        if (c >= 0xd800 && c <= 0xdbff && read + 1 < s.length && s.charCodeAt(read + 1) >= 0xdc00 && s.charCodeAt(read + 1) <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(read + 1) - 0xdc00);
          units = 2;
        } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
        const size = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
        if (written + size > dest.length) break;
        if (size === 1) dest[written] = c;
        else if (size === 2) { dest[written] = 0xc0 | (c >> 6); dest[written + 1] = 0x80 | (c & 63); }
        else if (size === 3) { dest[written] = 0xe0 | (c >> 12); dest[written + 1] = 0x80 | ((c >> 6) & 63); dest[written + 2] = 0x80 | (c & 63); }
        else { dest[written] = 0xf0 | (c >> 18); dest[written + 1] = 0x80 | ((c >> 12) & 63); dest[written + 2] = 0x80 | ((c >> 6) & 63); dest[written + 3] = 0x80 | (c & 63); }
        read += units;
        written += size;
      }
      return { read, written };
    }
  }
  class TextDecoder {
    #fatal; #ignoreBOM;
    constructor(label = "utf-8", options = {}) {
      if (!["utf-8", "utf8", "unicode-1-1-utf-8"].includes(String(label).trim().toLowerCase())) throw new RangeError(`TextDecoder only decodes UTF-8, not ${label}`);
      this.#fatal = !!options.fatal; this.#ignoreBOM = !!options.ignoreBOM;
    }
    get encoding() { return "utf-8"; }
    get fatal() { return this.#fatal; }
    get ignoreBOM() { return this.#ignoreBOM; }
    decode(input) { const text = utf8Decode(bytesOf(input), this.#fatal); return !this.#ignoreBOM && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; }
  }
  define("TextEncoder", TextEncoder);
  define("TextDecoder", TextDecoder);

  const wellFormed = (s) => String(s).replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�");
  const formEncode = (s) => encodeURIComponent(wellFormed(s)).replace(/%20/g, "+").replace(/[!'()~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const percentDecode = (s) => {
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "%" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; continue; }
      const code = s.codePointAt(i);
      if (code > 0xffff) i++;
      for (const b of utf8Encode(String.fromCodePoint(code))) bytes.push(b);
    }
    return utf8Decode(bytes, false);
  };
  const formDecode = (s) => percentDecode(s.replace(/\+/g, " "));
  const owners = new WeakMap();
  const kReset = Symbol("reset");
  class URLSearchParams {
    #list = [];
    constructor(init = "") {
      if (init instanceof URLSearchParams) this.#list = init.#list.map(([k, v]) => [k, v]);
      else if (init !== null && typeof init === "object") {
        if (typeof init[Symbol.iterator] === "function") {
          for (const pair of init) { const p = [...pair]; if (p.length !== 2) throw new TypeError("each pair needs a name and a value"); this.#list.push([String(p[0]), String(p[1])]); }
        } else for (const key of Object.keys(init)) this.#list.push([key, String(init[key])]);
      } else this[kReset](String(init));
    }
    [kReset](query) {
      this.#list = query.replace(/^\?/, "").split("&").filter(Boolean).map((part) => {
        const at = part.indexOf("=");
        return at < 0 ? [formDecode(part), ""] : [formDecode(part.slice(0, at)), formDecode(part.slice(at + 1))];
      });
    }
    #changed() { const owner = owners.get(this); if (owner) owner(this.toString()); }
    get size() { return this.#list.length; }
    append(name, value) { this.#list.push([String(name), String(value)]); this.#changed(); }
    delete(name, value) { name = String(name); this.#list = this.#list.filter(([k, v]) => !(k === name && (value === undefined || v === String(value)))); this.#changed(); }
    get(name) { const found = this.#list.find(([k]) => k === String(name)); return found ? found[1] : null; }
    getAll(name) { return this.#list.filter(([k]) => k === String(name)).map(([, v]) => v); }
    has(name, value) { return this.#list.some(([k, v]) => k === String(name) && (value === undefined || v === String(value))); }
    set(name, value) {
      name = String(name); value = String(value);
      const at = this.#list.findIndex(([k]) => k === name);
      if (at < 0) this.#list.push([name, value]);
      else { this.#list[at][1] = value; this.#list = this.#list.filter(([k], i) => k !== name || i === at); }
      this.#changed();
    }
    sort() { this.#list = this.#list.map((p, i) => [p, i]).sort((a, b) => (a[0][0] < b[0][0] ? -1 : a[0][0] > b[0][0] ? 1 : a[1] - b[1])).map(([p]) => p); this.#changed(); }
    forEach(fn, thisArg) { for (const [k, v] of this.#list) fn.call(thisArg, v, k, this); }
    *entries() { for (const [k, v] of this.#list) yield [k, v]; }
    *keys() { for (const [k] of this.#list) yield k; }
    *values() { for (const [, v] of this.#list) yield v; }
    [Symbol.iterator]() { return this.entries(); }
    toString() { return this.#list.map(([k, v]) => `${formEncode(k)}=${formEncode(v)}`).join("&"); }
  }
  define("URLSearchParams", URLSearchParams);

  const bracket = (host) => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);
  const compose = (p) => {
    const auth = p.username ? p.username + (p.password ? ":" + p.password : "") + "@" : "";
    const host = bracket(p.hostname) + (p.port ? ":" + p.port : "");
    return p.authority ? `${p.protocol}//${auth}${host}${p.pathname}${p.search}${p.hash}` : `${p.protocol}${p.pathname}${p.search}${p.hash}`;
  };
  const encodePart = (value, extra = "") => String(value).toWellFormed().replace(new RegExp(`%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9._~!$&'()*+,;=:@/%${extra}-]`, "gu"), (c) => encodeURIComponent(c));
  const parse = (input, base) => {
    const parsed = native.parseURL(input, base === undefined ? null : base);
    if (!parsed) throw new TypeError(`Invalid URL: ${input}`);
    return parsed;
  };
  class URL {
    #p; #params;
    constructor(input, base) {
      this.#p = parse(String(input), base === undefined ? undefined : String(base));
      this.#params = new URLSearchParams(this.#p.search);
      owners.set(this.#params, (query) => { this.#p.search = query ? "?" + query : ""; });
    }
    static canParse(input, base) { try { new URL(input, base); return true; } catch { return false; } }
    static parse(input, base) { try { return new URL(input, base); } catch { return null; } }
    #replace(change) {
      const next = { ...this.#p, ...change };
      try { this.#p = parse(compose(next)); } catch { return; }
      this.#params[kReset](this.#p.search);
    }
    get href() { return compose(this.#p); }
    set href(value) { this.#p = parse(String(value)); this.#params[kReset](this.#p.search); }
    get origin() { return this.#p.special && this.#p.authority && this.#p.protocol !== "file:" ? `${this.#p.protocol}//${this.host}` : "null"; }
    get protocol() { return this.#p.protocol; }
    set protocol(value) { this.#replace({ protocol: String(value).replace(/:.*$/, "") + ":" }); }
    get username() { return this.#p.username; }
    set username(value) { this.#replace({ username: encodeURIComponent(String(value)) }); }
    get password() { return this.#p.password; }
    set password(value) { this.#replace({ password: encodeURIComponent(String(value)) }); }
    get host() { return bracket(this.#p.hostname) + (this.#p.port ? ":" + this.#p.port : ""); }
    set host(value) { const m = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(String(value)); if (m) this.#replace({ hostname: m[1], port: m[2] ?? this.#p.port }); }
    get hostname() { return this.#p.hostname; }
    set hostname(value) { this.#replace({ hostname: String(value) }); }
    get port() { return this.#p.port; }
    set port(value) { this.#replace({ port: String(value).replace(/\D.*$/, "") }); }
    get pathname() { return this.#p.pathname; }
    set pathname(value) { const v = encodePart(value); this.#replace({ pathname: this.#p.authority && !v.startsWith("/") ? "/" + v : v }); }
    get search() { return this.#p.search.length > 1 ? this.#p.search : ""; }
    set search(value) { const v = encodePart(String(value).replace(/^\?/, ""), "?"); this.#replace({ search: v ? "?" + v : "" }); }
    get searchParams() { return this.#params; }
    get hash() { return this.#p.hash.length > 1 ? this.#p.hash : ""; }
    set hash(value) { const v = encodePart(String(value).replace(/^#/, ""), "?"); this.#replace({ hash: v ? "#" + v : "" }); }
    toString() { return this.href; }
    toJSON() { return this.href; }
  }
  define("URL", URL);

  const tokenName = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
  class Headers {
    #map = new Map();
    constructor(init) {
      if (init === undefined || init === null) return;
      if (init instanceof Headers) { init.forEach((v, k) => this.append(k, v)); return; }
      if (typeof init[Symbol.iterator] === "function") { for (const pair of init) { const p = [...pair]; if (p.length !== 2) throw new TypeError("each header needs a name and a value"); this.append(p[0], p[1]); } return; }
      for (const key of Object.keys(init)) this.append(key, init[key]);
    }
    static #name(name) { const n = String(name).toLowerCase(); if (!tokenName.test(n)) throw new TypeError(`${name} isn't a valid header name`); return n; }
    static #value(value) { const v = String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, ""); if (/[\0\r\n]/.test(v)) throw new TypeError("a header value can't contain a line break"); return v; }
    append(name, value) { const n = Headers.#name(name); const v = Headers.#value(value); this.#map.set(n, this.#map.has(n) ? `${this.#map.get(n)}, ${v}` : v); }
    delete(name) { this.#map.delete(Headers.#name(name)); }
    get(name) { const n = Headers.#name(name); return this.#map.has(n) ? this.#map.get(n) : null; }
    has(name) { return this.#map.has(Headers.#name(name)); }
    set(name, value) { this.#map.set(Headers.#name(name), Headers.#value(value)); }
    forEach(fn, thisArg) { for (const [k, v] of this.entries()) fn.call(thisArg, v, k, this); }
    *entries() { for (const k of [...this.#map.keys()].sort()) yield [k, this.#map.get(k)]; }
    *keys() { for (const [k] of this.entries()) yield k; }
    *values() { for (const [, v] of this.entries()) yield v; }
    [Symbol.iterator]() { return this.entries(); }
  }
  define("Headers", Headers);

  const bodyText = (body) => {
    if (body === undefined || body === null) return null;
    if (typeof body === "string") return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return utf8Decode(bytesOf(body), false);
    throw new TypeError("a body is a string, URLSearchParams or UTF-8 bytes");
  };
  const defaultType = (body, headers) => {
    if (headers.has("content-type") || body === undefined || body === null) return;
    if (typeof body === "string") headers.set("content-type", "text/plain;charset=UTF-8");
    else if (body instanceof URLSearchParams) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
  };
  class Response {
    #body; #used = false;
    constructor(body = null, init = {}) {
      this.#body = bodyText(body) ?? "";
      this.status = init.status === undefined ? 200 : Number(init.status);
      this.statusText = init.statusText === undefined ? "" : String(init.statusText);
      this.headers = new Headers(init.headers);
      defaultType(body, this.headers);
      this.url = "";
      this.redirected = false;
      this.type = "default";
    }
    get ok() { return this.status >= 200 && this.status < 300; }
    get bodyUsed() { return this.#used; }
    #take() { if (this.#used) return Promise.reject(new TypeError("Body has already been consumed")); this.#used = true; return Promise.resolve(this.#body); }
    text() { return this.#take(); }
    json() { return this.#take().then((t) => JSON.parse(t)); }
    bytes() { return this.#take().then((t) => utf8Encode(t)); }
    arrayBuffer() { return this.bytes().then((b) => b.buffer); }
    clone() {
      if (this.#used) throw new TypeError("Body has already been consumed");
      const copy = new Response(this.#body, { status: this.status, statusText: this.statusText, headers: this.headers });
      Object.assign(copy, { url: this.url, redirected: this.redirected, type: this.type });
      return copy;
    }
    static json(data, init = {}) { const headers = new Headers(init.headers); if (!headers.has("content-type")) headers.set("content-type", "application/json"); return new Response(JSON.stringify(data), { ...init, headers }); }
    static error() { const r = new Response(null, { status: 0 }); r.type = "error"; return r; }
  }
  define("Response", Response);
  class Request {
    constructor(input, init = {}) {
      const from = input instanceof Request ? input : null;
      this.url = new URL(from ? from.url : String(input)).href;
      this.method = String(init.method ?? from?.method ?? "GET").toUpperCase();
      this.headers = new Headers(init.headers ?? from?.headers);
      const body = init.body !== undefined ? init.body : from?.body;
      defaultType(body, this.headers);
      this.body = bodyText(body);
      this.signal = init.signal ?? from?.signal ?? null;
    }
  }
  define("Request", Request);

  const kAbort = Symbol("abort");
  class AbortSignal {
    #listeners = [];
    constructor() { this.aborted = false; this.reason = undefined; this.onabort = null; }
    addEventListener(type, fn, options) { if (type === "abort" && typeof fn === "function") this.#listeners.push({ fn, once: !!(options && options.once) }); }
    removeEventListener(type, fn) { if (type === "abort") this.#listeners = this.#listeners.filter((l) => l.fn !== fn); }
    throwIfAborted() { if (this.aborted) throw this.reason; }
    [kAbort](reason) {
      if (this.aborted) return;
      this.aborted = true;
      this.reason = reason === undefined ? new DOMException("This operation was aborted", "AbortError") : reason;
      const event = { type: "abort", target: this };
      const listeners = this.#listeners;
      this.#listeners = listeners.filter((l) => !l.once);
      for (const fn of [this.onabort, ...listeners.map((l) => l.fn)]) { if (typeof fn === "function") { try { fn.call(this, event); } catch (error) { reportError(error); } } }
    }
    static abort(reason) { const s = new AbortSignal(); s[kAbort](reason); return s; }
    static timeout(ms) { const s = new AbortSignal(); addTimer(() => s[kAbort](new DOMException("The operation timed out", "TimeoutError")), ms, [], false); return s; }
    static any(signals) { const s = new AbortSignal(); for (const one of signals) { if (one.aborted) { s[kAbort](one.reason); break; } one.addEventListener("abort", () => s[kAbort](one.reason), { once: true }); } return s; }
  }
  class AbortController {
    constructor() { this.signal = new AbortSignal(); }
    abort(reason) { this.signal[kAbort](reason); }
  }
  define("AbortSignal", AbortSignal);
  define("AbortController", AbortController);

  const FETCH_ID = "ardia-fetch-";
  const MAX_FETCHES = 16;
  let nextFetch = 0;
  let inFlight = 0;
  const fetches = new Map();
  const waiting = [];
  const pump = () => { while (inFlight < MAX_FETCHES && waiting.length) waiting.shift()(); };
  define("fetch", (input, init = {}) => new Promise((resolve, reject) => {
    const request = new Request(input, init);
    const signal = request.signal;
    if (signal && signal.aborted) return reject(signal.reason);
    const timeoutMs = Math.min(60000, Math.max(1000, Number(init.timeoutMs) || 30000));
    const id = FETCH_ID + ++nextFetch;
    let settled = false;
    let guard = 0;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      outcome(resolve, reject);
    };
    const release = () => {
      if (!fetches.delete(id)) return;
      clearTimer(guard);
      inFlight--;
      pump();
    };
    const onAbort = () => {
      const at = waiting.indexOf(launch);
      if (at >= 0) waiting.splice(at, 1);
      settle((_, no) => no(signal.reason));
    };
    const launch = () => {
      if (settled) return;
      try {
        guard = addTimer(() => { release(); settle((_, no) => no(new TypeError("fetch got no answer from Ardia"))); }, timeoutMs + 5000, [], false);
      } catch (error) {
        return settle((_, no) => no(error));
      }
      inFlight++;
      fetches.set(id, { requested: request.url, settle: (outcome) => { release(); settle(outcome); } });
      const params = { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), timeoutMs };
      if (request.body !== null) params.body = request.body;
      const problem = native.send(JSON.stringify({ id, method: "net.fetch", params }));
      if (problem) { release(); settle((_, no) => no(new TypeError(problem))); }
    };
    if (signal) signal.addEventListener("abort", onAbort);
    waiting.push(launch);
    pump();
  }));
  const answerFetch = (message) => {
    const pending = fetches.get(message.id);
    if (!pending) return;
    if (message.error) return pending.settle((_, no) => no(new TypeError(message.error.message || "fetch failed")));
    const r = message.result || {};
    if (r.ok === false) return pending.settle((_, no) => no(new TypeError(r.reason || "fetch failed")));
    const response = new Response(r.body ?? "", { status: r.status ?? 200, statusText: r.statusText ?? "", headers: r.headers ?? {} });
    response.url = r.url || pending.requested;
    response.redirected = response.url !== pending.requested;
    response.type = "basic";
    pending.settle((yes) => yes(response));
  };

  const listeners = new Set();
  const early = [];
  native.onLine((line) => {
    if (line.includes('"' + FETCH_ID)) {
      let message = null;
      try { message = JSON.parse(line); } catch {}
      if (message && typeof message.id === "string" && message.id.startsWith(FETCH_ID) && !("method" in message)) return answerFetch(message);
    }
    if (listeners.size === 0) { if (early.length < 256) early.push(line); return; }
    for (const fn of [...listeners]) { try { fn(line); } catch (error) { reportError(error); } }
  });
  define("__ardiaBridge", Object.freeze({
    send(line) { const problem = native.send(String(line)); if (problem) throw new Error(problem); },
    onLine(fn) {
      if (typeof fn !== "function") throw new TypeError("onLine needs a function");
      listeners.add(fn);
      if (early.length) { const held = early.splice(0); queueMicrotask(() => { for (const line of held) { try { fn(line); } catch (error) { reportError(error); } } }); }
      return () => listeners.delete(fn);
    },
  }));
})
"""#
}
