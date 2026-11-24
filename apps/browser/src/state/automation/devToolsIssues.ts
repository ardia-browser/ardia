import type { InspectionSession } from "./devToolsSession";

export const MAX_ISSUES = 200;
const MAX_TEXT = 2048;

type Fields = Record<string, unknown>;

export type IssueKind = "cors" | "cookie" | "csp" | "mixed-content" | "deprecation" | "heavy-ad" | "blocked-by-response" | "low-contrast" | "quirks-mode" | "generic" | "other";
export type IssueSeverity = "error" | "warning" | "info";

export type Affected = {
  request: { requestId: string | null; url: string | null } | null;
  nodeId: number | null;
  frameId: string | null;
  source: { url: string | null; line: number | null; column: number | null } | null;
  cookie: { name: string | null; domain: string | null; path: string | null } | null;
  resourceUrl: string | null;
};

export type DescribedIssue = { code: string; kind: IssueKind; severity: IssueSeverity; title: string; explanation: string; fix: string; reasons: string[]; affected: Affected };

const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: unknown, key: string): unknown => (isFields(value) && Object.hasOwn(value, key) ? value[key] : undefined);
const text = (value: unknown, max = MAX_TEXT): string | null => (typeof value === "string" ? value.slice(0, max) : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const words = (value: unknown): string[] => (Array.isArray(value) ? value.map((v) => text(v, 128)).filter((v): v is string => v !== null).slice(0, 16) : []);

function affectedOf(details: unknown): Affected {
  const request = field(details, "request");
  const location = field(details, "sourceCodeLocation") ?? field(details, "location");
  const cookie = field(details, "cookie");
  const nodeId = num(field(details, "violatingNodeId")) ?? num(field(details, "nodeId")) ?? num(field(details, "frameOwnerNodeId"));
  const frame = field(details, "frame");
  return {
    request: isFields(request) ? { requestId: text(request.requestId, 256), url: text(request.url) } : null,
    nodeId,
    frameId: text(field(frame, "frameId"), 256) ?? text(field(details, "frameId"), 256),
    source: isFields(location) ? { url: text(location.url), line: num(location.lineNumber), column: num(location.columnNumber) } : null,
    cookie: isFields(cookie) ? { name: text(cookie.name, 256), domain: text(cookie.domain, 256), path: text(cookie.path, 256) } : null,
    resourceUrl: text(field(details, "insecureURL")) ?? text(field(details, "blockedURL")),
  };
}

const COOKIE_EXPLAINED: Readonly<Record<string, [string, string]>> = {
  ExcludeSameSiteUnspecifiedTreatedAsLax: ["The cookie has no SameSite attribute, so it is treated as SameSite=Lax and wasn't sent on this cross-site request.", "Set SameSite=None; Secure on cookies meant for cross-site use."],
  ExcludeSameSiteNoneInsecure: ["The cookie says SameSite=None without Secure, so the browser refused it.", "Add the Secure attribute and serve it over HTTPS."],
  ExcludeSameSiteLax: ["The cookie is SameSite=Lax and this request is cross-site, so it wasn't sent.", "Use SameSite=None; Secure if the cookie must travel cross-site."],
  ExcludeSameSiteStrict: ["The cookie is SameSite=Strict and this request is cross-site, so it wasn't sent.", "Loosen SameSite only if the cookie must travel cross-site."],
  WarnSameSiteUnspecifiedCrossSiteContext: ["The cookie has no SameSite attribute and was used cross-site; it will stop working as defaults tighten.", "Set SameSite explicitly."],
  ExcludeThirdPartyPhaseout: ["The browser blocks this third-party cookie.", "Move to partitioned cookies (CHIPS), the Storage Access API or first-party state."],
  WarnThirdPartyPhaseout: ["This third-party cookie will be blocked as third-party cookies are phased out.", "Move to partitioned cookies (CHIPS), the Storage Access API or first-party state."],
  ExcludeThirdPartyCookieBlockedInFirstPartySet: ["The browser blocked this third-party cookie even within its related website set.", "Use the Storage Access API or partitioned cookies."],
  ExcludeDomainNonASCII: ["The cookie's Domain attribute has non-ASCII characters.", "Punycode-encode the domain."],
  WarnDomainNonASCII: ["The cookie's Domain attribute has non-ASCII characters.", "Punycode-encode the domain."],
  ExcludeInvalidSameParty: ["The cookie uses an invalid SameParty attribute.", "Remove SameParty."],
};

const CORS_EXPLAINED: Readonly<Record<string, string>> = {
  MissingAllowOriginHeader: "The response has no Access-Control-Allow-Origin header, so the page can't read it.",
  AllowOriginMismatch: "The response's Access-Control-Allow-Origin names a different origin than the page's.",
  WildcardOriginNotAllowed: "The request sends credentials, so Access-Control-Allow-Origin can't be *.",
  MultipleAllowOriginValues: "Access-Control-Allow-Origin holds more than one value.",
  PreflightMissingAllowOriginHeader: "The preflight response has no Access-Control-Allow-Origin header.",
  PreflightInvalidStatus: "The preflight request didn't get a 2xx answer.",
  PreflightDisallowedRedirect: "The preflight request was redirected, which CORS doesn't allow.",
  MethodDisallowedByPreflightResponse: "The preflight response doesn't list this request's method in Access-Control-Allow-Methods.",
  HeaderDisallowedByPreflightResponse: "The preflight response doesn't list one of this request's headers in Access-Control-Allow-Headers.",
  InvalidAllowCredentials: "The request sends credentials but Access-Control-Allow-Credentials isn't true.",
  CorsDisabledScheme: "CORS requests only work for http and https addresses.",
  InsecurePrivateNetwork: "A request from a less private context to a more private network was blocked (Private Network Access).",
  PreflightMissingAllowPrivateNetwork: "The private-network preflight response lacks Access-Control-Allow-Private-Network: true.",
  UnexpectedPrivateNetworkAccess: "The request reached a more private network than its address space allowed.",
  NoCorsRedirectModeNotFollow: "A no-cors request must follow redirects.",
  RedirectContainsCredentials: "The redirect address contains a user name or password.",
  DisallowedByMode: "The request's mode doesn't allow this cross-origin load.",
};

const CSP_EXPLAINED: Readonly<Record<string, string>> = {
  kInlineViolation: "An inline script or style was blocked by the Content Security Policy.",
  kEvalViolation: "eval or a similar string-to-code call was blocked by the Content Security Policy.",
  kURLViolation: "A resource from a source the Content Security Policy doesn't allow was blocked.",
  kTrustedTypesSinkViolation: "A string reached a DOM sink that requires a Trusted Type.",
  kTrustedTypesPolicyViolation: "A Trusted Types policy name isn't allowed by the policy.",
  kWasmEvalViolation: "WebAssembly compilation was blocked because the policy lacks 'wasm-unsafe-eval'.",
};

function describeCookie(details: unknown): Omit<DescribedIssue, "code" | "affected"> {
  const reasons = [...words(field(details, "cookieExclusionReasons")), ...words(field(details, "cookieWarningReasons"))];
  const excluded = words(field(details, "cookieExclusionReasons")).length > 0;
  const known = reasons.map((r) => COOKIE_EXPLAINED[r]).filter((r): r is [string, string] => !!r);
  return {
    kind: "cookie",
    severity: excluded ? "error" : "warning",
    title: excluded ? "A cookie was blocked" : "A cookie will stop working",
    explanation: known.map((k) => k[0]).join(" ") || `Cookie issue: ${reasons.join(", ") || "unknown reason"}.`,
    fix: [...new Set(known.map((k) => k[1]))].join(" ") || "Check the cookie's SameSite, Secure, Domain and Partitioned attributes.",
    reasons,
  };
}

function describe(code: string, details: unknown): Omit<DescribedIssue, "code" | "affected"> {
  switch (code) {
    case "CookieIssue":
      return describeCookie(details);
    case "CorsIssue": {
      const status = field(details, "corsErrorStatus");
      const reason = text(field(status, "corsError"), 128) ?? "Unknown";
      const parameter = text(field(status, "failedParameter"), 256);
      return {
        kind: "cors",
        severity: field(details, "isWarning") === true ? "warning" : "error",
        title: "A cross-origin request was blocked",
        explanation: `${CORS_EXPLAINED[reason] ?? `CORS refused the request (${reason}).`}${parameter ? ` Failed value: ${parameter}.` : ""}`,
        fix: "Have the server send matching Access-Control-Allow-* headers for this origin, method and headers, or fetch it from the same origin.",
        reasons: [reason],
      };
    }
    case "ContentSecurityPolicyIssue": {
      const type = text(field(details, "contentSecurityPolicyViolationType"), 128) ?? "";
      const directive = text(field(details, "violatedDirective"), 256);
      const reportOnly = field(details, "isReportOnly") === true;
      return {
        kind: "csp",
        severity: reportOnly ? "warning" : "error",
        title: reportOnly ? "Content Security Policy would block this (report-only)" : "Content Security Policy blocked this",
        explanation: `${CSP_EXPLAINED[type] ?? "The Content Security Policy blocked this."}${directive ? ` Violated directive: ${directive}.` : ""}${text(field(details, "blockedURL")) ? ` Blocked: ${text(field(details, "blockedURL"))}.` : ""}`,
        fix: "Move inline code to files, use nonces or hashes, or add the source to the directive if it is trusted.",
        reasons: [type || "unknown"],
      };
    }
    case "MixedContentIssue": {
      const status = text(field(details, "resolutionStatus"), 128) ?? "";
      const blocked = status === "MixedContentBlocked";
      return {
        kind: "mixed-content",
        severity: blocked ? "error" : "warning",
        title: blocked ? "Insecure content was blocked on a secure page" : "A secure page loaded insecure content",
        explanation: `The HTTPS page asked for ${text(field(details, "insecureURL")) ?? "an http:// resource"} over plain HTTP (${status || "unknown"}).`,
        fix: "Load the resource over HTTPS.",
        reasons: [status || "unknown"],
      };
    }
    case "DeprecationIssue": {
      const type = text(field(details, "type"), 128) ?? "unknown";
      return { kind: "deprecation", severity: "warning", title: "The page uses a deprecated feature", explanation: `Deprecated feature: ${type}. It may stop working in a future version.`, fix: "Move to the feature's replacement.", reasons: [type] };
    }
    case "HeavyAdIssue": {
      const reason = text(field(details, "reason"), 128) ?? "unknown";
      return { kind: "heavy-ad", severity: "warning", title: "An ad used too many resources", explanation: `The ad frame crossed a resource limit (${reason}) and may be unloaded.`, fix: "Reduce the ad's network and CPU use.", reasons: [reason] };
    }
    case "BlockedByResponseIssue": {
      const reason = text(field(details, "reason"), 128) ?? "unknown";
      return { kind: "blocked-by-response", severity: "error", title: "A response was blocked by its headers", explanation: `The response's cross-origin headers blocked it (${reason}).`, fix: "Send Cross-Origin-Resource-Policy or the matching COEP/COOP headers.", reasons: [reason] };
    }
    case "LowTextContrastIssue":
      return { kind: "low-contrast", severity: "warning", title: "Text contrast is too low", explanation: `Contrast ratio ${num(field(details, "contrastRatio")) ?? "?"} is below ${num(field(details, "thresholdAA")) ?? "the AA threshold"}.`, fix: "Darken the text or lighten its background.", reasons: [] };
    case "QuirksModeIssue":
      return { kind: "quirks-mode", severity: "warning", title: "The page renders in quirks mode", explanation: "The document has no or an old doctype, so layout follows legacy rules.", fix: "Start the document with <!DOCTYPE html>.", reasons: [] };
    case "GenericIssue": {
      const type = text(field(details, "errorType"), 128) ?? "unknown";
      return { kind: "generic", severity: "warning", title: "The page has a problem DevTools flagged", explanation: `Issue: ${type}.`, fix: "Fix the flagged element or attribute.", reasons: [type] };
    }
    default:
      return { kind: "other", severity: "info", title: "DevTools flagged an issue", explanation: `Issue type ${code}.`, fix: "See the issue details.", reasons: [] };
  }
}

const DETAILS_KEY: Readonly<Record<string, string>> = {
  CookieIssue: "cookieIssueDetails",
  CorsIssue: "corsIssueDetails",
  ContentSecurityPolicyIssue: "contentSecurityPolicyIssueDetails",
  MixedContentIssue: "mixedContentIssueDetails",
  DeprecationIssue: "deprecationIssueDetails",
  HeavyAdIssue: "heavyAdIssueDetails",
  BlockedByResponseIssue: "blockedByResponseIssueDetails",
  LowTextContrastIssue: "lowTextContrastIssueDetails",
  QuirksModeIssue: "quirksModeIssueDetails",
  GenericIssue: "genericIssueDetails",
};

export function describeIssue(raw: unknown): DescribedIssue | null {
  const issue = isFields(raw) && isFields(raw.issue) ? raw.issue : raw;
  const code = text(field(issue, "code"), 128);
  if (!code || !/^[A-Za-z]+$/.test(code)) return null;
  const detailsKey = Object.hasOwn(DETAILS_KEY, code) ? DETAILS_KEY[code]! : null;
  const allDetails = field(issue, "details");
  const details = detailsKey ? field(allDetails, detailsKey) : allDetails;
  return { code, ...describe(code, details), affected: affectedOf(details) };
}

const keyOf = (issue: DescribedIssue) => JSON.stringify([issue.code, issue.severity, issue.explanation, issue.reasons, issue.affected]);

export function describeIssues(raw: readonly unknown[]): { issues: DescribedIssue[]; dropped: number; byKind: Record<string, number> } {
  const seen = new Set<string>();
  const issues: DescribedIssue[] = [];
  let dropped = 0;
  for (const item of raw) {
    const described = describeIssue(item);
    if (!described) continue;
    const key = keyOf(described);
    if (seen.has(key)) continue;
    seen.add(key);
    if (issues.length >= MAX_ISSUES) {
      dropped++;
      continue;
    }
    issues.push(described);
  }
  const byKind: Record<string, number> = {};
  for (const issue of issues) byKind[issue.kind] = (byKind[issue.kind] ?? 0) + 1;
  const order: IssueSeverity[] = ["error", "warning", "info"];
  issues.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  return { issues, dropped, byKind };
}

export async function collectIssues(session: InspectionSession, waitMs: number) {
  const raw: unknown[] = [];
  const stop = session.on((method, params) => {
    if (method === "Audits.issueAdded" && raw.length < MAX_ISSUES * 4) raw.push(params);
  });
  try {
    await session.send("Audits.enable");
    await session.pause(waitMs);
    return describeIssues(raw);
  } finally {
    stop();
  }
}
