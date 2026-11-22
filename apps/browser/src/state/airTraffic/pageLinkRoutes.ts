import { displayHost, punycodeEncode } from "@ardia/core";
import { parseMatchPattern, type MatchSpec } from "../../lib/matchPattern";
import { exactAddress, isWildcardPattern, linkText, type AirTrafficConfig, type LinkCondition, type TargetUsable } from "./rules";

export type PageLinkPattern = [source: string, flags: string];
export type PageLinkRoute = [source: string, flags: string, action: "route" | "stay"];

export const MAX_PAGE_LINK_ROUTES = 512;

const regexEscape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const globSource = (glob: string, star: string) => regexEscape(glob).replace(/\\\*/g, star);

const asciiGlob = (glob: string) => glob.split(".").map((label) => (/^[\x00-\x7f]*$/.test(label) ? label : `xn--${punycodeEncode(label)}`)).join(".");

const WEB = "^https?://";
const HOST_CHARS = "[^/?#@:]*";
const HOST_END = "(?=[:/?#]|$)";

export const SIGN_IN_PATTERNS: readonly PageLinkPattern[] = [
  [`${WEB}(?:accounts\\.google\\.com|login\\.microsoftonline\\.com|login\\.live\\.com|login\\.windows\\.net|appleid\\.apple\\.com|${HOST_CHARS}\\.okta\\.com|${HOST_CHARS}\\.auth0\\.com|id\\.atlassian\\.com)${HOST_END}`, "i"],
  ["^https?://[^#]*[?&](?:redirect_uri|redirect_url|response_type|client_id|samlrequest|samlresponse|relaystate|openid\\.mode|openid\\.return_to|oauth_token|wctx)=", "i"],
];

const SIGN_IN = SIGN_IN_PATTERNS.map(([source, flags]) => new RegExp(source, flags));

export const signInLink = (url: string) => SIGN_IN.some((pattern) => pattern.test(url));

function hostPatterns(host: string): PageLinkPattern[] {
  return [...new Set([host, displayHost(host)])].map((h) => [`${WEB}(?:${HOST_CHARS}\\.)?${regexEscape(h)}\\.?${HOST_END}`, ""]);
}

const portSource = (spec: MatchSpec) => (spec.port === "*" ? "(?::\\d+)?" : spec.port === "80" || spec.port === "443" ? `(?::${spec.port})?` : `:${spec.port}`);

function matchPatternPatterns(pattern: string): PageLinkPattern[] {
  const spec = parseMatchPattern(pattern);
  if ("error" in spec) return [];
  if (spec.all) return [["^https?://[^/?#@]*(?:[/?#]|$)", ""]];
  const schemes = spec.schemes.filter((s) => s === "http" || s === "https");
  if (!schemes.length || spec.file) return [];
  const host = !spec.host ? HOST_CHARS : spec.sub ? `(?:${HOST_CHARS}\\.)?${regexEscape(spec.host)}` : regexEscape(spec.host);
  const start = `^(?:${schemes.join("|")})://${host}\\.?${portSource(spec)}`;
  const paths = new Set([globSource(spec.path, "[^#]*"), globSource(encodeURI(spec.path), "[^#]*")]);
  if (spec.path.endsWith("/*")) paths.add(regexEscape(spec.path.slice(0, -2)));
  return [...paths].map((path) => [`${start}${path}(?=#|$)`, ""]);
}

function wildcardPatterns(pattern: string): PageLinkPattern[] {
  const lower = pattern.toLowerCase();
  const glob = lower.includes("*") ? lower : `*${lower}*`;
  const out: PageLinkPattern[] = [];
  for (const g of new Set([glob, asciiGlob(glob)])) {
    const slash = g.indexOf("/");
    if (slash < 0) {
      out.push([`${WEB}${globSource(g, HOST_CHARS)}${HOST_END}`, "i"]);
      continue;
    }
    out.push([`${WEB}${globSource(g.slice(0, slash), HOST_CHARS)}(?::\\d+)?${globSource(g.slice(slash), "[^#]*")}(?=#|$)`, "i"]);
  }
  return out;
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

export function inAppLinkRoutes(config: AirTrafficConfig, sourceProfiles: ReadonlySet<string>, usable: TargetUsable, lastProfile: string): PageLinkRoute[] {
  if (!config.inAppLinks || !sourceProfiles.size) return [];
  const out: PageLinkRoute[] = SIGN_IN_PATTERNS.map(([source, flags]) => [source, flags, "stay"]);
  const seen = new Set<string>();
  let routes = false;
  for (const rule of config.rules) {
    if (!rule.enabled || rule.from) continue;
    const target = rule.profileId ?? lastProfile;
    if (!usable(target, null)) continue;
    const action = sourceProfiles.size === 1 && sourceProfiles.has(target) ? "stay" : "route";
    routes ||= action === "route";
    for (const [source, flags] of pageLinkPatterns(rule.when)) {
      const key = `${source}\n${flags}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([source, flags, action]);
    }
  }
  return routes ? out.slice(0, MAX_PAGE_LINK_ROUTES) : [];
}
