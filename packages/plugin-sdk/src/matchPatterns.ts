export type MatchParts = { scheme: "https" | "http"; host: string; port: string | null; path: string };

export function matchParts(pattern: string): MatchParts | null {
  const found = /^(https?):\/\/([^/:]+)(?::(\*|\d{1,5}))?(\/.*)$/.exec(pattern);
  if (!found) return null;
  return { scheme: found[1] as "https" | "http", host: (found[2] ?? "").toLowerCase(), port: found[3] ?? null, path: found[4] ?? "/" };
}

const escapeRegExp = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

const globToRegExp = (glob: string) => new RegExp(`^${escapeRegExp(glob).replace(/\*/g, ".*")}$`);

function hostCovers(outer: string, inner: string): boolean {
  if (outer === "*") return true;
  if (outer.startsWith("*.")) {
    const base = outer.slice(2);
    const innerBase = inner.startsWith("*.") ? inner.slice(2) : inner;
    return innerBase === base || innerBase.endsWith(`.${base}`);
  }
  return outer === inner;
}

export function patternCovers(outer: string, inner: string): boolean {
  const a = matchParts(outer);
  const b = matchParts(inner);
  if (!a || !b || a.scheme !== b.scheme || !hostCovers(a.host, b.host)) return false;
  if (a.port !== "*" && a.port !== b.port) return false;
  return globToRegExp(a.path).test(b.path);
}

export const coveredBy = (patterns: readonly string[], inner: string): boolean => patterns.some((outer) => patternCovers(outer, inner));

export function urlMatches(pattern: string, url: string): boolean {
  const parts = matchParts(pattern);
  const target = /^(https?):\/\/([^/:?#]+)(?::(\d{1,5}))?([^?#]*)?(\?[^#]*)?/.exec(url);
  if (!parts || !target || target[1] !== parts.scheme) return false;
  const host = (target[2] ?? "").toLowerCase();
  if (!hostCovers(parts.host, host)) return false;
  if (parts.port !== null && parts.port !== "*" && parts.port !== (target[3] ?? "")) return false;
  return globToRegExp(parts.path).test(`${target[4] || "/"}${target[5] ?? ""}`);
}

export function hostCoveredBy(hosts: readonly string[] | "*" | false | undefined, host: string): boolean {
  if (hosts === "*") return true;
  if (!Array.isArray(hosts)) return false;
  return hosts.some((outer) => (outer.includes(":") || host.includes(":") ? outer === host : hostCovers(outer, host)));
}
