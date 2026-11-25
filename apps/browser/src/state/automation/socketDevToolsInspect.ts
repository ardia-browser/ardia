import { noteDevTools } from "../telemetry/cliCounts";
import { consentToken } from "../telemetry/client";
import { MAX_PROPERTIES, SELECTOR_LIMIT, stylesFor } from "./devToolsCascade";
import { collectIssues, describeIssues, MAX_ISSUES } from "./devToolsIssues";
import { withInspection } from "./devToolsSession";
import { MAX_MAPS_PER_CALL, SourceMapResolver } from "./devToolsSourceMaps";
import { CAUSE_CHAIN_FUNCTION, chainOf, resolveChain } from "./devToolsStacks";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { int, obj, TAB, text } from "./socketSchema";
import { tabOf } from "./socketTargets";
import { OpError } from "./workspaceTargets";

async function issues(params: Record<string, unknown>, call: SocketCall) {
  const consent = consentToken();
  if (params.tab !== undefined && params.issues !== undefined) throw new OpError("bad_request", "Give tab or issues, not both.");
  if (params.tab === undefined) {
    if (!Array.isArray(params.issues)) throw new OpError("bad_request", "Give a tab to collect its issues, or issues to explain.");
    const described = describeIssues(params.issues);
    noteDevTools("issues_reported", described.issues.length, consent);
    return { tab: null, ...described };
  }
  const tab = tabOf(params.tab);
  const waitMs = (params.waitMs as number | undefined) ?? 500;
  const described = await withInspection(tab.id, call.connection, (session) => collectIssues(session, waitMs));
  call.stillServing();
  noteDevTools("issues_reported", described.issues.length, consent);
  return { tab: tab.id, ...described };
}

function stackTrace(params: Record<string, unknown>) {
  const consent = consentToken();
  const chain = chainOf(params.error);
  if (!chain.length) throw new OpError("bad_request", "error must be an error ({name, message, stack, cause}), a list of them, or {exceptionDetails}.");
  const resolver = new SourceMapResolver({ maps: params.sourceMaps as Record<string, unknown> | undefined, scripts: params.scripts as Record<string, unknown> | undefined });
  const resolved = resolveChain(chain, resolver);
  noteDevTools("source_maps_resolved", resolver.resolvedCount, consent);
  noteDevTools("source_maps_failed", resolver.failures.length, consent);
  return { chain: resolved, sourceMaps: { resolved: resolver.resolvedCount, failed: resolver.failures } };
}

async function styles(params: Record<string, unknown>, call: SocketCall) {
  const consent = consentToken();
  const tab = tabOf(params.tab);
  const selector = params.selector as string;
  if (!selector.trim() || selector.length > SELECTOR_LIMIT || /[\u0000]/.test(selector)) throw new OpError("bad_request", `selector must be a CSS selector of at most ${SELECTOR_LIMIT} characters.`);
  const properties = (params.properties as string[] | undefined) ?? null;
  const result = await withInspection(tab.id, call.connection, (session) => stylesFor(session, selector, properties));
  call.stillServing();
  noteDevTools("style_lookups", 1, consent);
  return { tab: tab.id, ...result };
}

const PROPERTY_NAME = { type: "string", pattern: "^(?:--[A-Za-z0-9_-]{1,200}|-?[a-zA-Z][a-zA-Z0-9-]{0,80})$" } as const;

export const DEVTOOLS_INSPECT_METHODS: MethodSpec[] = [
  {
    name: "devtools.issues",
    mutates: false,
    description: "DevTools Issues for a tab (CORS, cookies and SameSite, Content Security Policy, mixed content, deprecations, …), each explained with a fix and the affected request, element, source line or cookie (never its value). Or explain Audits.issueAdded payloads you pass as issues",
    params: obj(
      {
        tab: TAB,
        waitMs: int("How long to listen for new issues after the existing ones arrive, in milliseconds (default 500)", 0, 10000),
        issues: { type: "array", maxItems: MAX_ISSUES * 4, description: "Audits.issueAdded payloads (or their issue objects) to explain instead of reading a tab" },
      },
      [],
    ),
    result: "{tab, issues:[{code, kind, severity, title, explanation, fix, reasons, affected:{request, nodeId, frameId, source, cookie}}], dropped, byKind}",
    run: issues,
  },
  {
    name: "devtools.stackTrace",
    mutates: false,
    description: `Resolve an error's stack through source maps, keeping its whole Error.cause chain. error is {name, message, stack, cause}, a list of those (what Runtime.callFunctionOn on the error with devtools.causeChainFunction returns), or {exceptionDetails}. Maps come only from what you pass: sourceMaps (a map, its JSON, or a data: URL) or scripts (a script's text, whose inline data: map is read). Ardia fetches nothing`,
    params: obj(
      {
        error: { type: ["object", "array"], description: "The error, its cause chain, or {exceptionDetails, causes}" },
        sourceMaps: { type: "object", description: `Source maps by script address (a map, its JSON or a data: URL), at most ${MAX_MAPS_PER_CALL}` },
        scripts: { type: "object", description: `Script text by script address, for scripts with an inline data: source map, at most ${MAX_MAPS_PER_CALL}` },
      },
      ["error"],
    ),
    result: "{chain:[{name, message, frames:[{functionName, url, line, column, async, original:{source, line, column, name}}]}], sourceMaps:{resolved, failed:[{url, reason}]}}",
    run: stackTrace,
  },
  {
    name: "devtools.causeChainFunction",
    mutates: false,
    description: "A function declaration to pass to Runtime.callFunctionOn with an error as this: it answers the error and its Error.cause chain as [{name, message, stack}] for devtools.stackTrace",
    params: obj({}),
    result: "{functionDeclaration}",
    run: () => ({ functionDeclaration: CAUSE_CHAIN_FUNCTION }),
  },
  {
    name: "devtools.styles",
    mutates: false,
    description: "Which CSS rule wins for each property of the first element matching a selector: the winning declaration with its selector, specificity, origin and stylesheet line, every overridden one with why it lost, and the computed value. Without properties, the ones the page's own rules set",
    params: obj(
      {
        tab: TAB,
        selector: text("A CSS selector; the first match is inspected"),
        properties: { type: "array", items: PROPERTY_NAME, maxItems: MAX_PROPERTIES, description: "CSS property names to explain" },
      },
      ["tab", "selector"],
    ),
    result: "{tab, selector, properties:[{property, computed, winner:{value, important, origin, selector, specificity, source, inheritedFrom}, overridden:[{…, reason}]}]}",
    run: styles,
  },
];
