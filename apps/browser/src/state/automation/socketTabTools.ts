import type { JsonSchema } from "../../lib/jsonSchema";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { errorText } from "../../lib/errors";
import { controlTabDiagnostics, controlTabInput } from "../../platform/control";
import { noteTabDiagnostics, noteTabInput } from "../telemetry/cliCounts";
import { consentToken } from "../telemetry/consentPeriod";
import type { TabDiagnosticsRead, TabEngineRefusal, TabInputAction, TabInputDone, TabInputPrimed } from "../../platform/control";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { bool, int, obj, oneOf, TAB } from "./socketSchema";
import { tabOf } from "./socketTargets";
import { withinBudget } from "./socketWire";
import { DEFAULT_DIAGNOSTICS_LIMIT, DIAGNOSTIC_KINDS, MAX_DIAGNOSTICS_LIMIT, shapeDiagnostics, type DiagnosticKind } from "./tabDiagnostics";
import { checkedInput, INPUT_ACTIONS, INPUT_BUTTONS, INPUT_MODIFIERS, MAX_COORDINATE, MAX_KEY_LENGTH, MAX_TEXT_LENGTH, MAX_WHEEL_DELTA } from "./tabInput";
import type { ErrorCode } from "./automationMethods";
import { OpError } from "./workspaceTargets";

const REFUSAL_CODES: Record<string, ErrorCode> = {
  private: "refused",
  not_inspectable: "refused",
  privileged: "refused",
  not_painting: "failed",
  page_changed: "failed",
  busy: "failed",
  out_of_bounds: "bad_request",
  bad_key: "bad_request",
  bad_request: "bad_request",
  no_page: "failed",
};

const MISSING = "This Ardia's engine can't do that yet; update Ardia.";

function refused(reply: TabEngineRefusal): OpError {
  const code = REFUSAL_CODES[reply.code] ?? "failed";
  return new OpError(code, typeof reply.reason === "string" ? reply.reason.slice(0, 200) : "Ardia couldn't do that.");
}

type Served<T> = { reply: T | TabEngineRefusal } | { missing: string };

async function engine<T>(work: () => Promise<T | TabEngineRefusal>, call: SocketCall): Promise<Served<T>> {
  let reply: T | TabEngineRefusal;
  try {
    reply = await work();
  } catch (error) {
    call.stillServing();
    return { missing: errorText(error) };
  }
  call.stillServing();
  return typeof reply === "object" && reply !== null ? { reply } : { missing: MISSING };
}

const isRefusal = (reply: unknown): reply is TabEngineRefusal => typeof reply === "object" && reply !== null && (reply as { ok?: unknown }).ok === false;

async function diagnostics(params: Record<string, unknown>, call: SocketCall) {
  const consent = consentToken();
  const tab = tabOf(params.tab).id;
  const since = (params.since as number | undefined) ?? 0;
  const served = await engine<TabDiagnosticsRead>(() => controlTabDiagnostics(tab, since), call);
  if ("missing" in served) {
    noteTabDiagnostics("missing", false, consent);
    throw new OpError("failed", served.missing || MISSING);
  }
  const read = served.reply;
  if (isRefusal(read)) {
    noteTabDiagnostics("refused", false, consent);
    throw refused(read);
  }
  const shaped = shapeDiagnostics(
    read,
    { since, kind: (params.kind as DiagnosticKind | undefined) ?? "all", onlyErrors: params.onlyErrors === true, limit: (params.limit as number | undefined) ?? DEFAULT_DIAGNOSTICS_LIMIT },
    withinBudget,
  );
  let cleared: boolean | undefined;
  if (params.clear === true) {
    const after = shaped.nextSeq > since ? await engine<TabDiagnosticsRead>(() => controlTabDiagnostics(tab, shaped.nextSeq, shaped.nextSeq), call) : null;
    cleared = after === null || ("reply" in after && !isRefusal(after.reply) && after.reply.clearedBefore >= shaped.nextSeq);
  }
  noteTabDiagnostics("done", shaped.dropped > 0, consent);
  return { tab, ...shaped, ...(cleared === undefined ? {} : { cleared }) };
}

async function input(params: Record<string, unknown>, call: SocketCall) {
  const consent = consentToken();
  const tab = tabOf(params.tab).id;
  const action = params.action as TabInputAction;
  let checked: ReturnType<typeof checkedInput>;
  try {
    checked = checkedInput(params);
  } catch (error) {
    noteTabInput(action, "refused", false, consent);
    throw error;
  }
  const send = async (): Promise<Served<TabInputDone | TabInputPrimed>> => {
    const primed = await engine<TabInputDone | TabInputPrimed>(() => controlTabInput({ tabId: tab, ...checked, prime: true }), call);
    if ("missing" in primed || isRefusal(primed.reply) || !("painted" in primed.reply) || primed.reply.painted !== true) return primed;
    const token = primed.reply.token;
    call.stillServing();
    return await engine<TabInputDone | TabInputPrimed>(() => controlTabInput({ tabId: tab, ...checked, ...(token === undefined ? {} : { token }) }), call);
  };
  const served = await send();
  if ("missing" in served) {
    noteTabInput(checked.action, "missing", false, consent);
    throw new OpError("failed", served.missing || MISSING);
  }
  const answer = served.reply;
  if (!isRefusal(answer) && "painted" in answer) {
    noteTabInput(checked.action, "refused", false, consent);
    throw new OpError("failed", "The tab's page didn't draw a frame within 1 s, so it can't take input yet; try again.");
  }
  const reply = answer;
  if (isRefusal(reply)) {
    noteTabInput(checked.action, "refused", false, consent);
    throw refused(reply);
  }
  noteTabInput(checked.action, "done", reply.acked === true || reply.sent === true, consent);
  return { tab, action: checked.action, acked: reply.acked === true, ...(reply.sent === true ? { sent: true } : {}), viewport: reply.viewport };
}

const NUMBER = (description: string, minimum: number, maximum: number): JsonSchema => ({ type: "number", minimum, maximum, description });

const TAB_TOOLS: MethodSpec[] = [
  {
    name: "tabs.diagnostics",
    mutates: true,
    description: `A tab's console messages (every level, with uncaught exceptions and unhandled promise rejections marked by kind) and its network requests (method, address without its query, status, type, error and time taken), kept by the engine from the moment the tab was created, without DevTools attached. Entries share one sequence: pass the reply's nextSeq as since on the next call to get only what came after. dropped counts entries in that range the tab's fixed ring had already overwritten. Addresses lose their user name, password, query and fragment, and tokens, keys and passwords in messages read [redacted]. Private tabs keep none`,
    params: obj(
      {
        tab: TAB,
        since: int("Only entries with seq at or after this: the previous reply's nextSeq (default 0, everything kept)", 0, Number.MAX_SAFE_INTEGER),
        kind: oneOf(DIAGNOSTIC_KINDS, "all (default), console or network"),
        onlyErrors: bool("Only console warnings and errors and failed requests (a network error or a status of 400 or more)"),
        limit: int(`At most this many entries in all (default ${DEFAULT_DIAGNOSTICS_LIMIT})`, 1, MAX_DIAGNOSTICS_LIMIT),
        clear: bool("Forget what this read covered, up to its nextSeq; cleared says whether it took"),
      },
      ["tab"],
    ),
    result: "{tab, nextSeq, cleared?, console: [{seq, time, level, kind, message, source, line, frame, clipped?}], network: [{seq, time, method, url, status, type, frame, durationMs?, error?, failed, cached?}], dropped, more, capacity}",
    run: diagnostics,
  },
  {
    name: "tabs.input",
    mutates: true,
    description:
      "Real input to a tab's page, as the renderer gets it from the mouse and keyboard, so the page sees event.isTrusted true. It works on a tab in the background or off-screen without showing it, focusing its window or taking focus from another app, and attaches no debugger. x and y are CSS pixels from the page viewport's top left and must fall inside it; key takes a key value (a character, Enter, Tab, Backspace, Escape, ArrowLeft…) and code a key code (KeyA, Digit1…); text is inserted where the page's caret is, as typing or pasting does. Keys never reach Ardia's own shortcuts. acked says the renderer answered the last event within 2 s; text, which has no event to answer, says sent instead",
    params: obj(
      {
        tab: TAB,
        action: oneOf(INPUT_ACTIONS, "click, dblclick, move, down, up, wheel, key or text"),
        x: NUMBER("CSS pixels from the viewport's left (pointer actions)", 0, MAX_COORDINATE),
        y: NUMBER("CSS pixels from the viewport's top (pointer actions)", 0, MAX_COORDINATE),
        button: oneOf(INPUT_BUTTONS, "left (default) or middle; right clicks and control-clicks are refused, as they open Ardia's own menu"),
        clickCount: int("1, 2 or 3, for down and up only; click and dblclick set their own", 1, 3),
        modifiers: { type: "array", items: { type: "string", enum: [...INPUT_MODIFIERS] }, maxItems: INPUT_MODIFIERS.length, description: "Keys held: shift, control, alt, meta" },
        deltaX: NUMBER("Wheel: CSS pixels to scroll right (negative scrolls left)", -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA),
        deltaY: NUMBER("Wheel: CSS pixels to scroll down (negative scrolls up)", -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA),
        key: { type: "string", description: `Key: a key value, at most ${MAX_KEY_LENGTH} characters` },
        code: { type: "string", description: "Key: a key code such as KeyA" },
        text: { type: "string", description: `Text: at most ${MAX_TEXT_LENGTH} UTF-16 code units` },
      },
      ["tab", "action"],
    ),
    result: "{tab, action, acked, sent?, viewport: {width, height}}",
    run: input,
  },
];

export const TAB_TOOL_METHODS: MethodSpec[] = PLATFORM_FEATURES.nativeTabTools ? TAB_TOOLS : [];
