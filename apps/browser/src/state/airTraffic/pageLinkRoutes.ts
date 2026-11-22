import { displayHost, punycodeEncode } from "@ardia/core";
import { parseMatchPattern, type MatchSpec } from "../../lib/matchPattern";
import { exactAddress, isWildcardPattern, linkText, type AirTrafficConfig, type LinkCondition, type TargetUsable } from "./rules";

export type PageLinkPattern = [source: string, flags: "" | "i" | "ih" | "ip"];
export type PageLinkRoute = [source: PageLinkPattern[0], flags: PageLinkPattern[1], action: "route" | "stay"];

export const MAX_PAGE_LINK_ROUTES = 512;

const regexEscape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function globSource(glob: string, star: string, groups: { n: number }): string {
  const parts = glob.split(/\*+/);
  if (parts.length === 1) return regexEscape(glob);
  let out = regexEscape(parts[0]!);
  for (const middle of parts.slice(1, -1)) {
    groups.n += 1;
    out += `(?=(${star}*?${regexEscape(middle)}))\\${groups.n}`;
  }
  return `${out}${star}*${regexEscape(parts.at(-1)!)}`;
}

const encodedPath = (path: string) => {
  try {
    return encodeURI(path);
  } catch {
    return path;
  }
};

const asciiGlob = (glob: string) => glob.split(".").map((label) => (/^[\x00-\x7f]*$/.test(label) ? label : `xn--${punycodeEncode(label)}`)).join(".");

const WEB = "^https?://";
const HOST_CHAR = "[^/?#@:]";
const HOST_CHARS = `${HOST_CHAR}*`;
const PATH_CHAR = "[^#]";
const ANY_CHAR = "[^]";
const HOST_FORM = "ih";
const HOST_PATH_FORM = "ip";
const HOST_END = "(?=[:/?#]|$)";
const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443" };

export const SIGN_IN_PATTERNS: readonly PageLinkPattern[] = [
  [`${WEB}(?:accounts\\.google\\.com|login\\.microsoftonline\\.com|login\\.live\\.com|login\\.windows\\.net|appleid\\.apple\\.com|${HOST_CHARS}\\.okta\\.com|${HOST_CHARS}\\.auth0\\.com|id\\.atlassian\\.com)\\.?${HOST_END}`, "i"],
  ["^https?://[^#]*[?&](?:redirect_uri|redirect_url|response_type|client_id|samlrequest|samlresponse|relaystate|openid\\.mode|openid\\.return_to|oauth_token|wctx)=", "i"],
];

const SIGN_IN = SIGN_IN_PATTERNS.map(([source, flags]) => new RegExp(source, flags ? "i" : ""));

export const signInLink = (url: string) => SIGN_IN.some((pattern) => pattern.test(url));

function hostPatterns(host: string): PageLinkPattern[] {
  return [...new Set([host, displayHost(host)])].map((h) => [`${WEB}(?:${HOST_CHARS}\\.)?${regexEscape(h)}\\.?${HOST_END}`, ""]);
}

const portSource = (spec: MatchSpec, scheme: string) => (spec.port === "*" ? "(?::\\d+)?" : DEFAULT_PORTS[scheme] === spec.port ? `(?::${spec.port})?` : `:${spec.port}`);

function matchPatternPatterns(pattern: string): PageLinkPattern[] {
  const spec = parseMatchPattern(pattern);
  if ("error" in spec) return [];
  if (spec.all) return [["^https?://[^/?#@]*(?:[/?#]|$)", ""]];
  const schemes = spec.schemes.filter((s) => s === "http" || s === "https");
  if (!schemes.length || spec.file) return [];
  const host = !spec.host ? HOST_CHARS : spec.sub ? `(?:${HOST_CHARS}\\.)?${regexEscape(spec.host)}` : regexEscape(spec.host);
  const start = `^(?:${schemes.map((scheme) => `${scheme}://${host}\\.?${portSource(spec, scheme)}`).join("|")})`;
  const paths = new Set([spec.path, encodedPath(spec.path)].map((path) => globSource(path, PATH_CHAR, { n: 0 })));
  if (spec.path.endsWith("/*")) paths.add(regexEscape(spec.path.slice(0, -2)));
  return [...paths].map((path) => [`${start}${path}(?=#|$)`, ""]);
}

function wildcardPatterns(pattern: string): PageLinkPattern[] {
  const lower = pattern.toLowerCase();
  const glob = lower.includes("*") ? lower : `*${lower}*`;
  const form = glob.includes("/") ? HOST_PATH_FORM : HOST_FORM;
  return [...new Set([glob, asciiGlob(glob)])].map((g) => [`^${globSource(g, ANY_CHAR, { n: 0 })}$`, form]);
}

function containsPatterns(text: string): PageLinkPattern[] {
  const wanted = regexEscape(linkText(text));
  return [[`^[a-z][a-z0-9+.-]*://(?:www\\.[^]*${wanted}|(?!www\\.)[^]*${wanted})`, "i"]];
}

function equalsPatterns(text: string): PageLinkPattern[] {
  const address = exactAddress(text);
  if (!address) return [];
  const slash = address.indexOf("/");
  const hostPort = slash < 0 ? address : address.slice(0, slash);
  const path = slash < 0 ? "" : address.slice(slash);
  const colon = hostPort.lastIndexOf(":");
  const hasPort = colon > 0 && !hostPort.endsWith("]") && /^\d+$/.test(hostPort.slice(colon + 1));
  const host = hasPort ? hostPort.slice(0, colon) : hostPort;
  const port = hasPort ? `:${hostPort.slice(colon + 1)}` : "(?::(?:80|443))?";
  return [[`^https?://(?:[^/?#@]*@)?(?:www\\.)?${regexEscape(host)}${port}${regexEscape(path)}/*(?=[?#]|$)`, "i"]];
}

export function pageLinkPatterns(when: LinkCondition): PageLinkPattern[] {
  if (when.kind === "any") return [["^https?:", ""]];
  if (when.kind === "site") return hostPatterns(when.host);
  if (when.kind === "contains") return containsPatterns(when.text);
  if (when.kind === "equals") return equalsPatterns(when.text);
  if (isWildcardPattern(when.pattern)) return wildcardPatterns(when.pattern);
  return matchPatternPatterns(when.pattern);
}

const compiles = ([source, flags]: PageLinkPattern) => {
  try {
    new RegExp(source, flags ? "i" : "");
    return true;
  } catch {
    return false;
  }
};

export function inAppLinkRoutes(config: AirTrafficConfig, sourceProfiles: ReadonlySet<string>, usable: TargetUsable, lastProfile: string): PageLinkRoute[] {
  if (!config.inAppLinks || !sourceProfiles.size) return [];
  const out: PageLinkRoute[] = SIGN_IN_PATTERNS.map(([source, flags]) => [source, flags, "stay"]);
  const seen = new Set<string>();
  let routes = false;
  build: for (const rule of config.rules) {
    if (!rule.enabled || rule.from) continue;
    if (rule.profileId !== null && !usable(rule.profileId, null)) continue;
    const target = rule.profileId ?? lastProfile;
    const action = !usable(target, null) || sourceProfiles.has(target) ? "stay" : "route";
    for (const pattern of pageLinkPatterns(rule.when)) {
      if (!compiles(pattern)) break build;
      const key = pattern.join("\n");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([...pattern, action]);
      routes ||= action === "route";
    }
  }
  return routes ? out.slice(0, MAX_PAGE_LINK_ROUTES) : [];
}
