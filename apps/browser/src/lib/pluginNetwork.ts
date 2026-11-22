export const ANY_HOST = "*";
export const MAX_HOST_LENGTH = 253;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const NUMERIC_LABELS = /^[\d.]+$/;

export function normalizedHost(host: string): string {
  const lower = host.trim().toLowerCase();
  const bare = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
  return bare.endsWith(".") ? bare.slice(0, -1) : bare;
}

function isHostName(host: string): boolean {
  if (!host || host.length > MAX_HOST_LENGTH) return false;
  if (IPV4.test(host)) return true;
  if (NUMERIC_LABELS.test(host)) return false;
  return host.split(".").every((label) => LABEL.test(label));
}

export function hostPatternProblem(pattern: unknown): string | null {
  if (typeof pattern !== "string") return "isn't text";
  if (pattern === ANY_HOST) return null;
  if (pattern !== pattern.toLowerCase()) return "must be lowercase";
  if (/[\s/:@?#\\[\]]/.test(pattern)) return "must be a bare host, like api.example.com or *.example.com, without a scheme, port or path";
  if (pattern.startsWith("*.")) {
    const rest = pattern.slice(2);
    if (rest.includes("*")) return "can only have one * at its start";
    if (IPV4.test(rest)) return "can't put * in front of an IP address";
    if (!isHostName(rest) || rest.split(".").length < 2) return "must put * in front of a domain with at least two parts, like *.example.com";
    return null;
  }
  if (pattern.includes("*")) return "can only have * on its own or as *. at its start";
  if (!isHostName(pattern)) return "isn't a valid host name";
  return null;
}

export const isHostPattern = (pattern: unknown): pattern is string => hostPatternProblem(pattern) === null;

export function matchesAllowedHost(host: string, allowedHosts: readonly string[]): boolean {
  const target = normalizedHost(host);
  if (!target || target.length > MAX_HOST_LENGTH) return false;
  for (const pattern of allowedHosts) {
    if (!isHostPattern(pattern)) continue;
    if (pattern === ANY_HOST) return true;
    if (pattern.startsWith("*.")) {
      const domain = pattern.slice(2);
      if (target.endsWith(`.${domain}`)) return true;
    } else if (target === pattern) return true;
  }
  return false;
}

export function hostPatternCovers(broader: string, narrower: string): boolean {
  if (!isHostPattern(broader) || !isHostPattern(narrower)) return false;
  if (broader === ANY_HOST || broader === narrower) return true;
  if (narrower === ANY_HOST || !broader.startsWith("*.")) return false;
  return matchesAllowedHost(narrower.startsWith("*.") ? narrower.slice(2) : narrower, [broader]);
}
