import type { JsonSchema } from "../../lib/jsonSchema";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { controlClick, controlHitTest, controlScreenshot, controlSnapshot, controlWaitSettled } from "../../platform/control";
import { attachSession, detachSession, engineFailure, ownerOf, sendOn, sessionsOf } from "./engineCli";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { bool, int, obj, oneOf, TAB, text } from "./socketSchema";
import { tabOf } from "./socketTargets";
import { OpError } from "./workspaceTargets";

export const MAX_BATCH = 64;
const METHOD_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}\.[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CHILD_SESSION = /^[A-Za-z0-9]{1,128}$/;
const REF = { type: "string", pattern: "^e[0-9]{1,9}$", description: "A ref from tabs.snapshot (e12)" } as const satisfies JsonSchema;
const SESSION = int("A session from devtools.attach", 1, 2147483647);
const CDP_PARAMS: JsonSchema = { type: "object", description: "The method's params, as DevTools takes them" };
const CHILD: JsonSchema = { type: "string", description: "A child target's sessionId from Target.attachedToTarget, for flattened sessions" };
const COORD = { type: "number", minimum: -100000, maximum: 100000 } as const satisfies JsonSchema;

const engine = async <T>(work: Promise<T>, call: SocketCall): Promise<T> => {
  const out = await work.catch((error: unknown) => {
    throw engineFailure(error);
  });
  call.stillServing();
  return out;
};

function checkedMethod(method: unknown) {
  if (typeof method !== "string" || !METHOD_NAME.test(method)) throw new OpError("bad_request", "method must be a DevTools method name like Page.navigate.");
  return method;
}

function checkedChild(child: unknown) {
  if (child === undefined) return undefined;
  if (typeof child !== "string" || !CHILD_SESSION.test(child)) throw new OpError("bad_request", "sessionId must be a sessionId from Target.attachedToTarget.");
  return child;
}

function checkedParams(params: unknown) {
  if (params === undefined) return undefined;
  if (typeof params !== "object" || params === null || Array.isArray(params)) throw new OpError("bad_request", "params must be an object.");
  return params as Record<string, unknown>;
}

async function attach(params: Record<string, unknown>, call: SocketCall) {
  if (!(call.connection > 0)) throw new OpError("refused", "A DevTools session needs a socket connection that stays open.");
  const tab = tabOf(params.tab).id;
  const opened = await attachSession(call.connection, tab, call.serving);
  call.stillServing();
  return { session: opened.session, targetId: opened.targetId, tab };
}

async function send(params: Record<string, unknown>, call: SocketCall) {
  const reply = await sendOn(call.connection, {
    session: params.session as number,
    method: checkedMethod(params.method),
    params: checkedParams(params.params),
    sessionId: checkedChild(params.sessionId),
    timeoutMs: params.timeoutMs as number | undefined,
  });
  call.stillServing();
  return reply;
}

async function batch(params: Record<string, unknown>, call: SocketCall) {
  const commands = params.commands as unknown[];
  const stopOnError = params.stopOnError !== false;
  const checked = commands.map((command, index) => {
    if (typeof command !== "object" || command === null || Array.isArray(command)) throw new OpError("bad_request", `commands[${index}] must be {method, params?, sessionId?}.`);
    const fields = command as Record<string, unknown>;
    const unknown = Object.keys(fields).find((key) => key !== "method" && key !== "params" && key !== "sessionId");
    if (unknown) throw new OpError("bad_request", `commands[${index}] has ${unknown}, which a command doesn't take.`);
    return { method: checkedMethod(fields.method), params: checkedParams(fields.params), sessionId: checkedChild(fields.sessionId) };
  });
  const results: ({ result: Record<string, unknown>; offscreen?: boolean } | { error: { message: string } })[] = [];
  for (const command of checked) {
    call.stillServing();
    try {
      results.push(await sendOn(call.connection, { session: params.session as number, ...command }));
    } catch (error) {
      results.push({ error: { message: engineFailure(error).message } });
      if (stopOnError) break;
    }
  }
  call.stillServing();
  return { results, completed: results.filter((result) => "result" in result).length, stopped: results.length < checked.length };
}

async function detach(params: Record<string, unknown>, call: SocketCall) {
  return await detachSession(call.connection, params.session as number);
}

async function snapshot(params: Record<string, unknown>, call: SocketCall) {
  const tab = tabOf(params.tab).id;
  const shot = await engine(
    controlSnapshot(tab, {
      owner: ownerOf(call.connection),
      maxRefs: params.maxRefs as number | undefined,
      maxTextBytes: params.maxTextBytes as number | undefined,
      interactiveOnly: params.interactiveOnly as boolean | undefined,
      wholePage: params.wholePage as boolean | undefined,
      occlusion: params.occlusion as boolean | undefined,
    }),
    call,
  );
  return { tab, ...shot };
}

async function waitSettled(params: Record<string, unknown>, call: SocketCall) {
  const tab = tabOf(params.tab).id;
  const settled = await engine(
    controlWaitSettled(tab, {
      owner: ownerOf(call.connection),
      timeoutMs: params.timeoutMs as number | undefined,
      quietMs: params.quietMs as number | undefined,
      longRequestMs: params.longRequestMs as number | undefined,
      maxInflight: params.maxInflight as number | undefined,
      idle: params.idle as boolean | undefined,
      frame: params.frame as boolean | undefined,
    }),
    call,
  );
  return { tab, ...settled };
}

function target(params: Record<string, unknown>) {
  const hasRef = params.ref !== undefined;
  const hasPoint = params.x !== undefined || params.y !== undefined;
  if (hasRef === hasPoint || (hasPoint && (params.x === undefined || params.y === undefined))) throw new OpError("bad_request", "Give a ref, or a point as x and y, not both.");
  return hasRef ? { ref: params.ref as string } : { x: params.x as number, y: params.y as number };
}

async function hitTest(params: Record<string, unknown>, call: SocketCall) {
  const tab = tabOf(params.tab).id;
  const hit = await engine(controlHitTest(tab, { owner: ownerOf(call.connection), ...target(params) }), call);
  return { tab, ...hit };
}

async function click(params: Record<string, unknown>, call: SocketCall) {
  const tab = tabOf(params.tab).id;
  const at = target(params);
  call.stillServing();
  const clicked = await engine(
    controlClick(tab, {
      owner: ownerOf(call.connection),
      ...at,
      force: params.force as boolean | undefined,
      button: params.button as "left" | "right" | "middle" | undefined,
      clickCount: params.clickCount as number | undefined,
      modifiers: params.modifiers as number | undefined,
    }),
    call,
  );
  return { tab, ...clicked };
}

async function screenshot(params: Record<string, unknown>, call: SocketCall) {
  const tab = tabOf(params.tab).id;
  const clip = params.clip as { x: number; y: number; width: number; height: number } | undefined;
  const shot = await engine(
    controlScreenshot(tab, {
      owner: ownerOf(call.connection),
      format: params.format as "png" | "jpeg" | undefined,
      quality: params.quality as number | undefined,
      clip: clip ? { x: clip.x, y: clip.y, width: clip.width, height: clip.height } : undefined,
      scale: params.scale as number | undefined,
    }),
    call,
  );
  return { tab, ...shot };
}

const TARGET = {
  ref: REF,
  x: { ...COORD, description: "A point in CSS pixels from the viewport's top left; give y too" },
  y: { ...COORD, description: "The point's y in CSS pixels" },
};

const DEVTOOLS_SESSION_METHODS: MethodSpec[] = [
  {
    name: "devtools.attach",
    mutates: false,
    description:
      "Open a DevTools session on a tab over this connection, with no approval prompt (the socket already checked who you are): every domain of that tab, its own iframes and workers through Target.setAutoAttach with flatten, and nothing else (no Target.getTargets, attachToTarget or createTarget; never a private tab or a chrome:// page). Events the tab sends arrive on this connection as devtools.event {session, method, params, sessionId?} (cut: true with bytes when one is over 900 KiB), and devtools.detached {session, reason} when it ends. It ends with devtools.detach, when the tab closes, when this connection closes or when control goes off. A tab that isn't on screen keeps drawing while the session is open",
    params: obj({ tab: TAB }, ["tab"]),
    result: "{session, targetId, tab}",
    run: attach,
  },
  {
    name: "devtools.send",
    mutates: true,
    description:
      "Send one DevTools command on a session from devtools.attach and answer its result. Target.setAutoAttach with flatten gives child sessions whose sessionId you pass here. Page.captureScreenshot on a tab that isn't on screen is answered from an offscreen copy of its surface (offscreen: true)",
    params: obj(
      {
        session: SESSION,
        method: text("A DevTools method, like Runtime.evaluate"),
        params: CDP_PARAMS,
        sessionId: CHILD,
        timeoutMs: int("Give up after this long (default 10000)", 1, 120000),
      },
      ["session", "method"],
    ),
    result: "{result, offscreen?}",
    run: send,
  },
  {
    name: "devtools.batch",
    mutates: true,
    description: `Send up to ${MAX_BATCH} DevTools commands on one session, one after another, and answer every result in order; by default it stops at the first error`,
    params: obj(
      {
        session: SESSION,
        commands: { type: "array", minItems: 1, maxItems: MAX_BATCH, items: { type: "object" }, description: "[{method, params?, sessionId?}]" },
        stopOnError: bool("Stop at the first command that fails (default true)"),
      },
      ["session", "commands"],
    ),
    result: "{results: [{result} | {error}], completed, stopped}",
    run: batch,
  },
  { name: "devtools.detach", mutates: false, description: "End a DevTools session from devtools.attach", params: obj({ session: SESSION }, ["session"]), result: "{closed}", run: detach },
  { name: "devtools.sessions", mutates: false, description: "The DevTools sessions this connection has open", params: obj({}), result: "[{session, tab, targetId}]", run: (_params, call) => sessionsOf(call.connection) },
];

const TAB_ENGINE_METHODS: MethodSpec[] = [
  {
    name: "tabs.snapshot",
    mutates: false,
    description:
      "The tab's page as a compact list of elements read from Chromium's accessibility tree across every frame (cross-site iframes and closed shadow roots included), each with a ref, role, accessible name, box in CSS pixels from the viewport's top left and a fingerprint of its role and name. When a modal dialog is open, only the topmost one is listed (scope: modal) unless wholePage. Interactive elements in view are hit-tested: one covered by something else says occludedBy with the covering element's ref. Refs stay the same for the same element; one whose element was replaced is found again by role and name when it's used",
    params: obj(
      {
        tab: TAB,
        maxRefs: int("List at most this many elements (default 400)", 1, 2000),
        maxTextBytes: int("Stop once names and values take this many bytes (default 65536)", 1024, 524288),
        interactiveOnly: bool("List only elements you can act on"),
        wholePage: bool("List the whole page even when a modal dialog is open"),
        occlusion: bool("Hit-test elements in view to find covered ones (default true)"),
      },
      ["tab"],
    ),
    result: "{tab, generation, viewport, scope, modal?, focused?, refs, truncated, counts, occlusion}",
    run: snapshot,
  },
  {
    name: "tabs.waitSettled",
    mutates: false,
    description:
      "Wait until the tab's page has settled: no navigation in flight, the page done loading, no network request started since the wait began still running (requests longer than longRequestMs and event streams don't count) for quietMs, then the renderer's main thread idle and the next frame committed. Answers settled: false with waitingOn when timeoutMs passes; the wait ends early if the tab closes or this connection does",
    params: obj(
      {
        tab: TAB,
        timeoutMs: int("Give up after this long (default 10000)", 100, 60000),
        quietMs: int("How long the network must stay quiet (default 500)", 0, 5000),
        longRequestMs: int("Requests running longer than this don't hold the wait (default 10000)", 500, 60000),
        maxInflight: int("Requests that may still run (default 0)", 0, 16),
        idle: bool("Wait for the main thread to be idle (default true)"),
        frame: bool("Wait for the next frame to commit (default true)"),
      },
      ["tab"],
    ),
    result: "{tab, settled, waitedMs, timedOut?, waitingOn?, navigations, network, idle, frame, loops, quietAtMs?, idleMs, frameMs}",
    run: waitSettled,
  },
  {
    name: "tabs.hitTest",
    mutates: false,
    description:
      "What a click at a ref's element, or at a point, would reach, across frames. When something else covers the element (a cookie banner, a dialog, an overlay), blocked is true and blocker names the covering layer with its box, and dismiss names the button inside it that most likely closes it (close, then reject, then accept), with up to 4 choices",
    params: obj({ tab: TAB, ...TARGET }, ["tab"]),
    result: "{tab, point, verified, hit?, target?, rebound?, blocked, blocker?, dismiss?, choices?}",
    run: hitTest,
  },
  {
    name: "tabs.click",
    mutates: true,
    description:
      "Click a ref's element, or a point, with trusted mouse input after the same hit test as tabs.hitTest: scrolls the element into view first, and when something covers it answers clicked: false with the blocker and the dismiss button instead of clicking it, unless force. It also refuses when the hit test can't confirm what the click reaches (reason: unverified) or when something moved over it after the pointer arrived (reason: moved)",
    params: obj(
      {
        tab: TAB,
        ...TARGET,
        force: bool("Click even when something covers the element"),
        button: oneOf(["left", "right", "middle"], "Which button (default left)"),
        clickCount: int("1, 2 for a double click or 3", 1, 3),
        modifiers: int("Alt 1, Ctrl 2, Meta/Command 4, Shift 8, added together", 0, 15),
      },
      ["tab"],
    ),
    result: "{tab, clicked, point, verified, hit?, target?, rebound?, blocked, blocker?, dismiss?, choices?}",
    run: click,
  },
  {
    name: "tabs.screenshot",
    mutates: false,
    description:
      "A screenshot of the tab's page copied from its compositor surface, which works when the tab isn't on screen, its window is minimized or covered or on another Space, or the screen is locked; the page is asked for a fresh frame first. JPEG (quality 80) unless format is png",
    params: obj(
      {
        tab: TAB,
        format: oneOf(["jpeg", "png"], "Image format (default jpeg)"),
        quality: int("JPEG quality (default 80)", 1, 100),
        clip: obj({ x: COORD, y: COORD, width: { type: "number", minimum: 1, maximum: 100000 }, height: { type: "number", minimum: 1, maximum: 100000 } }, ["x", "y", "width", "height"]),
        scale: { type: "number", minimum: 0.1, maximum: 4, description: "Scale the image (default 1, the screen's pixels)" },
      },
      ["tab"],
    ),
    result: "{tab, data, format, width, height, hidden, freshFrame}",
    run: screenshot,
  },
];

export const ENGINE_CLI_METHODS: MethodSpec[] = PLATFORM_FEATURES.drivesTabsFromEngine ? [...DEVTOOLS_SESSION_METHODS, ...TAB_ENGINE_METHODS] : [];
