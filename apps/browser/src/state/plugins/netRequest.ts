import { isFields } from "../../lib/decode";
import { allowedHostsOf, type PluginManifest } from "../../lib/pluginManifest";
import { matchesAllowedHost, reachesLoopback } from "../../lib/pluginNetwork";
import { pluginWebUrl } from "../../lib/pluginWebUrl";
import { urlParts } from "../../lib/urlParts";
import { notePlugin } from "../telemetry/pluginCounts";

export const FETCH_LIMITS = { headers: 50, headerBytes: 8 * 1024, bodyBytes: 512 * 1024, timeoutMs: [1000, 60_000], defaultTimeoutMs: 30_000 } as const;

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const FORBIDDEN_HEADERS = /^(host|cookie|cookie2|connection|content-length|transfer-encoding|keep-alive|upgrade|te|trailer|expect|origin|referer|proxy-.*|sec-.*)$/i;
const LOOPBACK_FOR_TESTS = "127.0.0.1";

export type Refusal = { code: "refused" | "bad_request"; message: string };
export type Target = { url: string; host: string; port: number; loopback: boolean; allowedHosts: string[] };
export type FetchRequest = { url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs: number; allowedHosts: string[] };

const refused = (message: string): Refusal => ({ code: "refused", message });
const bad = (message: string): Refusal => ({ code: "bad_request", message });

export function headersOf(raw: unknown): Record<string, string> | string {
  if (raw === undefined) return {};
  if (!isFields(raw)) return "headers is an object of header names to text.";
  const entries = Object.entries(raw);
  if (entries.length > FETCH_LIMITS.headers) return `headers has more than ${FETCH_LIMITS.headers} entries.`;
  const out: Record<string, string> = {};
  let size = 0;
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name)) return `headers has a bad name: ${JSON.stringify(name.slice(0, 64))}.`;
    if (FORBIDDEN_HEADERS.test(name)) return `Ardia sets ${name} itself.`;
    if (typeof value !== "string" || /[\r\n\0]/.test(value)) return `headers.${name} must be text on one line.`;
    size += name.length + value.length;
    out[name] = value;
  }
  return size > FETCH_LIMITS.headerBytes ? `headers are over ${FETCH_LIMITS.headerBytes / 1024} KB.` : out;
}

const SOCKET_SCHEMES: Record<string, string> = { "wss:": "https:", "ws:": "http:" };

export function targetOf(m: PluginManifest, raw: unknown, what: string, socket = false): Target | Refusal {
  if (m.permissions.network === false) return refused(`${what} needs the network permission.`);
  let given = raw;
  if (socket) {
    const scheme = typeof raw === "string" ? /^[a-z]+:/i.exec(raw)?.[0]?.toLowerCase() : undefined;
    if (!scheme || !SOCKET_SCHEMES[scheme]) return bad("url must be a ws:// or wss:// address.");
    given = SOCKET_SCHEMES[scheme] + (raw as string).slice(scheme.length);
  }
  const checked = pluginWebUrl(given);
  if ("problem" in checked) return bad(`url ${checked.problem}.`);
  const parts = urlParts(checked.url);
  const secure = /^https:/i.test(checked.url);
  const port = parts?.port ? Number(parts.port) : secure ? 443 : 80;
  const allowedHosts = allowedHostsOf(m.permissions);
  const loopback = reachesLoopback(checked.host, port, allowedHosts);
  if (!secure && !loopback && checked.host !== LOOPBACK_FOR_TESTS) {
    notePlugin("plugin_net_refusals");
    return refused(`${what} reaches only ${socket ? "wss" : "https"} addresses, or a local port the plugin lists.`);
  }
  if (!loopback && !matchesAllowedHost(checked.host, allowedHosts)) {
    notePlugin("plugin_net_refusals");
    return refused(`${checked.host} isn't one of the hosts this plugin may reach.`);
  }
  const url = socket ? (raw as string).slice(0, (raw as string).indexOf(":") + 1) + checked.url.slice(checked.url.indexOf(":") + 1) : checked.url;
  return { url, host: checked.host, port, loopback, allowedHosts };
}

export function fetchRequestOf(m: PluginManifest, params: Record<string, unknown>, what = "net.fetch"): FetchRequest | Refusal {
  const target = targetOf(m, params.url, what);
  if ("code" in target) return target;
  const method = typeof params.method === "string" ? params.method.toUpperCase() : "GET";
  if (!METHODS.includes(method)) return bad(`method is one of ${METHODS.join(", ")}.`);
  const headers = headersOf(params.headers);
  if (typeof headers === "string") return bad(headers);
  if (params.body !== undefined && typeof params.body !== "string") return bad("body is text; JSON.stringify an object first.");
  const body = params.body as string | undefined;
  if (body !== undefined && new TextEncoder().encode(body).length > FETCH_LIMITS.bodyBytes) return bad(`body is over ${FETCH_LIMITS.bodyBytes / 1024} KB.`);
  if (body !== undefined && (method === "GET" || method === "HEAD")) return bad(`A ${method} request has no body.`);
  const [least, most] = FETCH_LIMITS.timeoutMs;
  const given = params.timeoutMs;
  if (given !== undefined && (typeof given !== "number" || !Number.isInteger(given) || given < least || given > most)) return bad(`timeoutMs is a whole number from ${least} to ${most}.`);
  return { url: target.url, method, headers, ...(body !== undefined ? { body } : {}), timeoutMs: (given as number | undefined) ?? FETCH_LIMITS.defaultTimeoutMs, allowedHosts: target.allowedHosts };
}
