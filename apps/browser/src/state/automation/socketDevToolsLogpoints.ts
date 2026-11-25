import { controlOwnsTab } from "../../platform/control";
import { noteDevTools } from "../telemetry/cliCounts";
import { consentToken } from "../telemetry/client";
import { clearLogpoint, listLogpoints, MAX_EXPRESSION, setLogpoint } from "./devToolsLogpoints";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { int, obj, TAB, text } from "./socketSchema";
import { tabOf } from "./socketTargets";
import { OpError } from "./workspaceTargets";

async function logpoint(params: Record<string, unknown>, call: SocketCall) {
  const consent = consentToken();
  const tab = tabOf(params.tab);
  if (!(await controlOwnsTab(tab.id)).owned) {
    noteDevTools("logpoints_refused", 1, consent);
    throw new OpError("refused", "Logpoints go only on a tab the ardia command opened.");
  }
  call.stillServing();
  const url = params.url as string;
  if (!url || url.length > 2048 || url.includes("\u0000")) throw new OpError("bad_request", "url must be a script address or a source path of at most 2048 characters.");
  const result = await setLogpoint({
    connection: call.connection,
    serving: call.serving,
    tabId: tab.id,
    url,
    line: params.line as number,
    column: (params.column as number | undefined) ?? null,
    expression: params.expression as string,
    condition: (params.condition as string | undefined) ?? null,
  });
  noteDevTools("logpoints_set", 1, consent);
  return result;
}

export const DEVTOOLS_LOGPOINT_METHODS: MethodSpec[] = [
  {
    name: "devtools.logpoint",
    mutates: true,
    description: "Log an expression each time a line runs, without pausing the page, on a tab the command opened. url is the script's address or an original source path its source map names; the line is mapped through the map. Its console line starts with the answer's label. expression and condition run as the page's own JavaScript where the line runs, with the page's privileges, so they can change page state; keep them to reads. Logpoints end when this connection closes",
    params: obj(
      {
        tab: TAB,
        url: text("The script address, or an original source path like src/app.ts"),
        line: int("Line number, from 1", 1, 10_000_000),
        column: int("Column number, from 1", 1, 10_000_000),
        expression: text(`What to log, a JavaScript expression evaluated where the line runs (at most ${MAX_EXPRESSION} characters)`),
        condition: text("Log only when this JavaScript expression is truthy"),
      },
      ["tab", "url", "line", "expression"],
    ),
    result: "{id, tab, url, line, column, original, label, bound, pending, matchedScript}",
    run: logpoint,
  },
  {
    name: "devtools.logpoints",
    mutates: false,
    description: "The logpoints this connection holds",
    params: obj({}),
    result: "[{id, tab, url, line, column, original, label}]",
    run: (_params, call) => listLogpoints(call.connection),
  },
  {
    name: "devtools.clearLogpoint",
    mutates: true,
    description: "Remove one of this connection's logpoints, or all of them when id is left out",
    params: obj({ id: text("A logpoint id from devtools.logpoint") }),
    result: "{cleared}",
    run: (params, call) => clearLogpoint(call.connection, (params.id as string | undefined) ?? null),
  },
];
