import { appUrlOrigin, toAppUrl } from "./appUrls.ts";
import { cleanUrl } from "./cleanUrl.ts";
import { displayHost, punycodeEncode } from "./idn.ts";
import { PSL_TLDS } from "./tlds.ts";

type ParsedUrl = { scheme: string; host: string; port: string; path: string; query: string; hash: string };

const URL_PARTS = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d+))?([^?#]*)(\?[^#]*)?(#.*)?$/i;

function parseUrl(url: string): ParsedUrl | null {
  const m = URL_PARTS.exec(url.trim());
  if (!m) return null;
  return { scheme: m[1]!.toLowerCase(), host: m[2]!.toLowerCase(), port: m[3] ?? "", path: m[4] ?? "", query: m[5] ?? "", hash: m[6] ?? "" };
}

export function hostOf(url: string): string {
  return (parseUrl(url)?.host ?? "").replace(/^www\./, "");
}

const KNOWN_SCHEMES = new Set([
  "http", "https", "file", "about", "data", "blob", "mailto", "tel", "sms", "facetime", "ftp", "view-source",
  "ardia", "chrome", "chrome-extension", "devtools", "x-apple.systempreferences", "itms-apps", "slack", "zoommtg", "vscode",
  "cursor", "notion", "figma", "spotify", "linear", "obsidian", "raycast",
]);

const NON_SEARCH_EXTRA_SCHEMES = new Set(["javascript", "vbscript", "edge"]);
const SCHEME_HEAD = /^([a-z][a-z0-9+.-]*):/i;

export function hasKnownScheme(input: string): boolean {
  const m = SCHEME_HEAD.exec(input);
  if (!m) return false;
  const scheme = m[1]!.toLowerCase();
  return input.startsWith("://", scheme.length) || KNOWN_SCHEMES.has(scheme) || NON_SEARCH_EXTRA_SCHEMES.has(scheme);
}

const LOCAL_TLDS = new Set(["meta", "local", "localhost", "test", "internal", "lan"]);
let registries: Set<string> | undefined;
const knownTld = (tld: string) => LOCAL_TLDS.has(tld) || (registries ??= new Set(PSL_TLDS.split(/\s+/))).has(tld);

const isIPv4 = (host: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split(".").every((octet) => Number(octet) <= 255);

function isLocalHost(host: string): boolean {
  return (
    host === "localhost" ||
    !host.includes(".") ||
    host.startsWith("[") ||
    isIPv4(host) ||
    /\.(local|localhost|test|internal|lan|home\.arpa)$/.test(host)
  );
}

const LABEL_CHARS = /^[a-z0-9\u00a1-\uffff-]+$/i;
const isLabel = (part: string) => LABEL_CHARS.test(part) && part[0] !== "-" && !part.endsWith("-");
const isTld = (part: string) => (isLabel(part) && !/^\d/.test(part)) || /^xn--[a-z0-9-]+$/i.test(part);

function isHostName(name: string): boolean {
  if (name.toLowerCase() === "localhost" || /^\[[0-9a-f:.]+\]$/i.test(name) || isIPv4(name)) return true;
  const labels = name.split(".");
  return labels.length === 1 ? isLabel(name) : labels.slice(0, -1).every(isLabel) && isTld(labels.at(-1)!);
}

type HostMatch = { authority: string; name: string; port: string };

function matchHost(input: string): HostMatch | null {
  const end = input.search(/[/?#]/);
  const authority = end === -1 ? input : input.slice(0, end);
  const colon = authority.lastIndexOf(":");
  const port = colon !== -1 && /^:\d{1,5}$/.test(authority.slice(colon)) ? authority.slice(colon) : "";
  const bare = port ? authority.slice(0, colon) : authority;
  const name = bare.endsWith(".") ? bare.slice(0, -1) : bare;
  return isHostName(name) ? { authority, name, port } : null;
}

const JAVASCRIPT_URL = /^(?:view-source:)?javascript:/i;
const JAVASCRIPT_PREFIX = /^[\u0000-\u0020\u007f]*javascript:/i;

export const isJavaScriptUrl = (url: string) => JAVASCRIPT_URL.test(url.replace(/^[\u0000-\u0020]+/, "").replace(/[\t\n\r]/g, ""));

export function withoutJavaScriptScheme(text: string): string {
  let out = text;
  while (JAVASCRIPT_PREFIX.test(out)) out = out.replace(JAVASCRIPT_PREFIX, "");
  return out;
}

export function fixupUrl(raw: string): string | null {
  const url = fixup(raw);
  return url && !isJavaScriptUrl(url) ? toAppUrl(url) : null;
}

type SpacedAddress = { escaped: string; certain: boolean };

const WIKI_HOST = /(^|\.)(wikipedia|wiktionary|wikimedia|wikiquote|wikibooks|wikisource|wikinews|wikiversity|wikivoyage|wikidata|mediawiki)\.org$/;

function spacedAddress(input: string): SpacedAddress | null {
  if (!input.includes(" ") || /[^\S ]/.test(input)) return null;
  const end = input.search(/[/?#]/);
  if (end <= 0 || input.slice(0, end).includes(" ") || input.startsWith("/ ", end)) return null;
  const host = matchHost(input);
  if (!host) return null;
  const name = host.name.toLowerCase();
  if (KNOWN_SCHEMES.has(name) || name === "javascript") return null;
  const port = Number(host.port.slice(1));
  if (host.port && (port < 1 || port > 65535)) return null;
  const dotted = name.includes(".") && !/^[\d.]+$/.test(name);
  const ip = name.startsWith("[") || isIPv4(name);
  const local = name === "localhost" || ip || (!!host.port && !(dotted && !isLocalHost(name) && (port === 80 || port === 443)));
  if (!dotted && !local) return null;
  const rest = input.slice(host.authority.length);
  const wiki = WIKI_HOST.test(name) && /^\/wiki\/[^\s/?#]/.test(rest);
  const certain = local || wiki || /^[^\s?#]*\?(?:[^\s#]*&)?[^\s#&=]+=/.test(rest);
  return { escaped: input.replace(/ /g, "%20"), certain };
}

const asciiLabel = (label: string) =>
  /^[\x00-\x7f]*$/.test(label) ? label.replace(/[A-Z]+/g, (upper) => upper.toLowerCase()) : `xn--${punycodeEncode(Array.from(label.normalize("NFKC"), (c) => c.toLowerCase()).join(""))}`;

function addressKey(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/i.exec(url.trim());
  if (!m) return url.trim();
  const scheme = m[1]!.toLowerCase();
  const web = scheme === "http" || scheme === "https";
  const defaultPort = scheme === "https" ? 443 : scheme === "http" ? 80 : -1;
  const authority = m[2]!.replace(/^[^:@[\]]+/, (host) => host.split(".").map(asciiLabel).join(".")).replace(/[A-Z]+/g, (upper) => upper.toLowerCase()).replace(/:(\d+)$/, (port, digits: string) => (!web ? port : Number(digits) === defaultPort ? "" : `:${Number(digits)}`));
  const rest = web && !m[3]!.startsWith("/") ? `/${m[3]}` : m[3]!;
  return `${scheme}://${authority}${rest}`;
}

export const sameAddress = (a: string, b: string) => addressKey(a) === addressKey(b);

export function spacedAddressGuess(raw: string): string | null {
  const spaced = spacedAddress(raw.trim());
  return spaced && !spaced.certain ? fixupUrl(spaced.escaped) : null;
}

function fixup(raw: string): string | null {
  const trimmed = raw.trim();
  const spaced = spacedAddress(trimmed);
  const input = spaced?.certain ? spaced.escaped : trimmed;
  if (!input || (/\s/.test(input) && !/^([a-z][a-z0-9+.-]*:\/\/|\/[^\s/])/i.test(input))) return null;
  if (/^(about|data|mailto|tel|sms|facetime|view-source):/i.test(input)) return input;

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(input)?.[1]?.toLowerCase();
  if (scheme && KNOWN_SCHEMES.has(scheme) && (input.slice(scheme.length + 1).startsWith("//") || !/^\d/.test(input.slice(scheme.length + 1)))) {
    return scheme + input.slice(scheme.length).replace(/\s/g, "%20");
  }
  if (scheme && !KNOWN_SCHEMES.has(scheme) && input.slice(scheme.length + 1).startsWith("//")) return input;
  if (input.startsWith("/") && !input.startsWith("//")) return `file://${input.replace(/\s/g, "%20")}`;

  if (!/[.:/?#[]/.test(input)) return input.toLowerCase() === "localhost" ? `http://${input}` : null;
  const host = matchHost(input);
  if (!host) return null;
  const name = host.name.toLowerCase();
  const numeric = /^[\d.]+$/.test(name);
  if (numeric && !name.includes(".")) return null;
  const dotted = name.includes(".") && !numeric && name.charCodeAt(0) !== 91;
  const tld = dotted ? name.slice(name.lastIndexOf(".") + 1) : "";
  const rest = input.slice(host.authority.length);
  const special = name === "localhost" || name.charCodeAt(0) === 91 || numeric;
  const proto = isLocalHost(name) ? "http" : "https";
  if (special || (dotted && (knownTld(tld) || tld.startsWith("xn--")))) return `${proto}://${input}`;
  if (!host.port && !rest.includes("/") && !rest.includes("?") && !rest.includes("#")) return null;
  const path = /^[^?#]*/.exec(rest)![0];
  const query = /\?[^#]*/.exec(rest)?.[0] ?? "";
  const fragment = /#.*/.exec(rest)?.[0] ?? "";
  const parts = (host.port ? 1 : 0) + (path ? 1 : 0) + (query.length > 1 ? 1 : 0) + (fragment.length > 1 ? 1 : 0);
  return host.port || path.endsWith("/") || parts > 1 ? `${proto}://${input}` : null;
}

const SURROGATE_PAIR_OR_LONE = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

const wellFormed = (text: string) => text.replace(SURROGATE_PAIR_OR_LONE, (unit) => (unit.length === 2 ? unit : "\uFFFD"));

export function searchUrlFor(template: string, query: string): string {
  const q = encodeURIComponent(wellFormed(query.trim()));
  return template.includes("%s") ? template.replace(/%s/g, q) : template + q;
}

export function resolveInput(raw: string, search: string): string {
  const input = raw.trim();
  if (!input) return "";
  if (input.startsWith("?")) return input.length > 1 ? searchUrlFor(search, input.slice(1)) : "";
  return fixupUrl(input) ?? searchUrlFor(search, input);
}

export type PasteAction = { kind: "go"; url: string } | { kind: "search"; query: string };

export function classifyPaste(text: string): PasteAction | null {
  const trimmed = withoutJavaScriptScheme(text.trim()).trim();
  if (!trimmed) return null;
  const url = /\s/.test(trimmed) && !spacedAddress(trimmed)?.certain ? null : fixupUrl(trimmed);
  if (url && !/^(about|data):/i.test(url)) return { kind: "go", url: cleanUrl(url) };
  return { kind: "search", query: trimmed.replace(/\s+/g, " ").slice(0, 2000) };
}

export function sanitizePaste(text: string): string {
  if (!text) return "";
  const parts = text.trim().split(/(\s+)/);
  if (parts.length === 1 && !parts[0]) return " ";
  const spaced = parts.some((part, i) => i % 2 === 1 && !/[\r\n]/.test(part));
  return withoutJavaScriptScheme(parts.map((part, i) => (i % 2 === 0 || !/[\r\n]/.test(part) ? part : spaced ? " " : "")).join("")).trimStart();
}

const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443", ws: "80", wss: "443", ftp: "21" };

export function breadcrumb(url: string, title?: string): { host: string; trail: string[] } {
  const parsed = parseUrl(url);
  const app = appUrlOrigin(url);
  const port = parsed?.port && parsed.port !== DEFAULT_PORTS[parsed.scheme] ? `:${parsed.port}` : "";
  const host = app ?? (parsed ? displayHost(parsed.host).replace(/^www\./, "") + port : url);
  const seen = new Set([host.toLowerCase(), ...(app && parsed ? [parsed.host] : [])]);
  const trail = (title ?? "")
    .split(/\s[|/·–—-]\s/)
    .map((s) => s.trim())
    .filter((s) => {
      const key = s.toLowerCase();
      if (!s || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { host, trail };
}

export function urlForDisplay(url: string): string {
  if (appUrlOrigin(url)) return toAppUrl(url).replace(/^([^/]*\/\/[^/?#]*)\/(?=[?#]|$)/, "$1");
  const authority = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url);
  const rest = authority ? url.slice(authority[0].length).replace(/^[^/?#]*@/, "") : url;
  const host = /^[^/?#:]*/.exec(rest)![0];
  return (displayHost(host) + rest.slice(host.length)).replace(/^www\./i, "");
}
