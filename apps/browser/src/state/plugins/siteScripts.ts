export const KEPT_RESPONSE_HEADERS = ["content-type", "content-length", "content-disposition", "content-language", "etag", "last-modified", "retry-after", "cache-control", "date", "expires"];

export const FETCH_SCRIPT = (spec: Record<string, unknown>) => `
const spec = ${JSON.stringify(spec)};
const done = (value) => post("result", JSON.stringify(value));
if (location.origin !== spec.origin) return done({ error: "origin" });
const control = new AbortController();
const timer = setTimeout(() => control.abort(), spec.timeoutMs);
(async () => {
  try {
    const res = await fetch(spec.url, { method: spec.method, headers: spec.headers, body: spec.body, mode: "same-origin", credentials: "include", redirect: "manual", cache: "no-store", signal: control.signal });
    if (res.type === "opaqueredirect") return done({ error: "redirect" });
    const headers = {};
    for (const name of spec.keep) {
      const value = res.headers.get(name);
      if (value !== null) headers[name] = value.slice(0, 2048);
    }
    res.headers.forEach((value, name) => {
      if (name.startsWith("x-ratelimit-") && Object.keys(headers).length < 30) headers[name] = value.slice(0, 256);
    });
    const parts = [];
    let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        size += step.value.length;
        if (size > spec.cap) {
          reader.cancel().catch(() => {});
          return done({ error: "too_large" });
        }
        parts.push(step.value);
      }
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      all.set(part, at);
      at += part.length;
    }
    done({ status: res.status, headers, body: new TextDecoder("utf-8").decode(all) });
  } catch (e) {
    done({ error: control.signal.aborted ? "timeout" : "network" });
  } finally {
    clearTimeout(timer);
  }
})();`;

export const DOWNLOAD_START = (spec: Record<string, unknown>) => `
const spec = ${JSON.stringify(spec)};
const done = (value) => post("result", JSON.stringify(value));
if (location.origin !== spec.origin) return done({ error: "origin" });
const key = Symbol.for("ardia.sites");
if (!window[key]) Object.defineProperty(window, key, { value: { downloads: {} } });
const store = window[key].downloads;
const control = new AbortController();
const entry = { control, reader: null, left: null, cancelled: false };
store[spec.id] = entry;
const timer = setTimeout(() => control.abort(), spec.timeoutMs);
fetch(spec.url, { method: "GET", headers: spec.headers, mode: "same-origin", credentials: "include", redirect: "manual", cache: "no-store", signal: control.signal })
  .then((res) => {
    clearTimeout(timer);
    if (entry.cancelled || store[spec.id] !== entry) {
      if (res.body) res.body.cancel().catch(() => {});
      return done({ error: "gone" });
    }
    if (res.type === "opaqueredirect") {
      delete store[spec.id];
      return done({ error: "redirect" });
    }
    if (!res.ok || !res.body) {
      delete store[spec.id];
      if (res.body) res.body.cancel().catch(() => {});
      return done({ error: "status", status: res.status });
    }
    entry.reader = res.body.getReader();
    done({ status: res.status, total: Number(res.headers.get("content-length")) || 0 });
  })
  .catch(() => {
    clearTimeout(timer);
    if (store[spec.id] === entry) delete store[spec.id];
    done({ error: entry.cancelled ? "gone" : control.signal.aborted ? "timeout" : "network" });
  });`;

export const DOWNLOAD_NEXT = (id: string, chunk: number) => `
const id = ${JSON.stringify(id)};
const chunk = ${chunk};
const done = (value) => post("result", JSON.stringify(value));
const holder = window[Symbol.for("ardia.sites")];
const d = holder && holder.downloads[id];
if (!d || !d.reader || d.cancelled) return done({ error: "gone" });
(async () => {
  try {
    const parts = [];
    let size = 0;
    let end = false;
    if (d.left) {
      parts.push(d.left);
      size += d.left.length;
      d.left = null;
    }
    while (size < chunk) {
      const step = await d.reader.read();
      if (step.done) {
        end = true;
        break;
      }
      parts.push(step.value);
      size += step.value.length;
    }
    if (size > chunk) {
      const last = parts.pop();
      const keep = last.length - (size - chunk);
      parts.push(last.subarray(0, keep));
      d.left = last.subarray(keep);
      size = chunk;
    }
    if (end && !d.left) delete holder.downloads[id];
    const url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(new Blob(parts));
    });
    done({ data: url.slice(url.indexOf(",") + 1), size, end: end && !d.left });
  } catch (e) {
    if (holder.downloads[id] === d) delete holder.downloads[id];
    done({ error: d.cancelled ? "gone" : "network" });
  }
})();`;

export const DOWNLOAD_CANCEL = (id: string) => `
const holder = window[Symbol.for("ardia.sites")];
const d = holder && holder.downloads[${JSON.stringify(id)}];
if (d) {
  delete holder.downloads[${JSON.stringify(id)}];
  d.cancelled = true;
  d.control.abort();
  if (d.reader) d.reader.cancel().catch(() => {});
}
post("result", "true");`;

export const SITE_SCRIPTS = { fetch: FETCH_SCRIPT, downloadStart: DOWNLOAD_START, downloadNext: DOWNLOAD_NEXT, downloadCancel: DOWNLOAD_CANCEL, keptHeaders: KEPT_RESPONSE_HEADERS };
