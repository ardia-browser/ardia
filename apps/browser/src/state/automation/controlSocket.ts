import { guardedBySocketOrigin, type SocketOrigin } from "./socketSharedChokePoint";
import { commandTarget } from "../commands/commandTarget";
import { refuseSharedRunCommand } from "./workspaceSharedGuard";
import { create } from "zustand";
import {
  broadcastOnControlSocket,
  onControlClose,
  onControlRequest,
  onControlWritten,
  replyOnControlSocket,
  startControlSocket,
  stopControlSocket,
  type ControlRequest,
  type ControlSocketStatus,
} from "../../platform/automation";
import { systemInfo } from "../../platform/app";
import { useBrowser } from "../browser/store";
import { NoCommandWindowError, runCommand } from "../commands/commands";
import { noteControlCaller, noteSocketRun, noteSocketServing } from "../app/programControl";
import { parseControlCaller, type ControlCaller } from "../app/controlCaller";
import { errorText } from "../../lib/errors";
import { redactedEventData } from "./eventRedaction";
import { automationWindows, type AutomationWindow } from "./automationWindows";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";
import { controlTabTargets } from "../../platform/control";
import { TAB_IDLE_EVENTS, USER_IDLE_EVENTS, type AutomationEventName } from "./eventNames";
import { clientProtocolProblem, commands, failure, hello, parseRequest, parseSubscription, planRun, type RequestId, type Subscription } from "./automationMethods";
import { feedNeeds, idleToReplay, stopFeed, updateFeed } from "./automationFeed";
import { answerDecision, dropResponder, serveHooks, stopResponders } from "./decideSocket";
import { launchToReplay, recordLaunch, runLaunchActions } from "./lifecycleEvents";
import { startDecideHooks } from "./decideHooks";
import { offscreenMethod } from "./offscreen";
import { applyMethod, workspaceMethod } from "./workspaceMethods";
import { accessProblem, checkedParams, familyOf, methodSpec, methodsCatalog, runSpec, servingWhile, type ConnectionAccess } from "./socketCatalog";
import { registerSocketAreas } from "./socketAreas";
import { noteSocketCall } from "../telemetry/cliCounts";
import { capturePageMenus } from "../../platform/surfaces";
import { fittedEvent, fittedReply } from "./socketWire";
import { dismissSocketAsks } from "./socketAsk";
import { dropAllHistoryHandles, dropHistoryHandles } from "./historyHandles";
import { dropLateResults, forgetTabCalls } from "./tabCalls";
import { backgroundInstance } from "../app/appSettings";
import { programControlOn } from "../app/programControlSetting";

export const useControlSocket = create<{ status: ControlSocketStatus | null }>()(() => ({ status: null }));

let generation: number | null = null;
let applied = false;
let chain: Promise<void> = Promise.resolve();
let listening = false;
const subscriptions = new Map<number, Subscription>();
const openConnections = new Set<number>();
const launchSent = new Set<number>();
const unwrittenRuns = new Set<number>();
const callers = new Map<number, ControlCaller>();
const idleReplays = new Map<number, Record<string, unknown>[]>();
let nextTicket = 0;

const controlOn = () => programControlOn(useBrowser.getState());

export const replyLine = (id: RequestId, body: Body, method?: string, consent: ConsentToken | null = null) => fittedReply(id, body, method ? methodSpec(method) : undefined, consent);

function send(connection: number, id: RequestId, body: Body, ticket = 0, method?: string, consent: ConsentToken | null = null) {
  replyOnControlSocket(connection, replyLine(id, body, method, consent), ticket);
}

function runWritten(tickets: readonly number[]) {
  for (const ticket of tickets) if (unwrittenRuns.delete(ticket)) noteSocketRun(-1);
}

export function eventTargets(subs: ReadonlyMap<number, Subscription>, name: AutomationEventName, data: Record<string, unknown>) {
  const full: number[] = [];
  const plain: number[] = [];
  for (const [connection, sub] of subs) {
    if (!sub.events.has(name)) continue;
    if (TAB_IDLE_EVENTS.has(name) && !sub.tabIdle.has(data.idle as number)) continue;
    if (USER_IDLE_EVENTS.has(name) && !sub.userIdle.has(data.idle as number)) continue;
    (sub.fullUrls ? full : plain).push(connection);
  }
  return { full, plain };
}

function deliver(name: AutomationEventName, data: Record<string, unknown>, time = Date.now(), only?: number) {
  const { full, plain } = eventTargets(only === undefined ? subscriptions : new Map([[only, subscriptions.get(only)!]]), name, data);
  const consent = consentToken();
  if (full.length) broadcastOnControlSocket(full, fittedEvent(name, time, data, consent));
  if (plain.length) broadcastOnControlSocket(plain, fittedEvent(name, time, redactedEventData(data), consent));
}

export type FeedConsumer = { subscriptions: () => Iterable<Subscription>; deliver: (name: AutomationEventName, data: Record<string, unknown>, time: number) => void };

const consumers = new Map<string, FeedConsumer>();

function broadcast(name: AutomationEventName, data: Record<string, unknown>) {
  if (generation !== null) deliver(name, data);
  const time = Date.now();
  for (const consumer of consumers.values()) consumer.deliver(name, data, time);
}

export function refreshFeed() {
  const all = [...subscriptions.values(), ...[...consumers.values()].flatMap((c) => [...c.subscriptions()])];
  if (all.length) updateFeed(feedNeeds(all), broadcast);
  else stopFeed();
}

type MethodHandler = (method: string, params: Record<string, unknown>, serving: () => boolean) => Body | Promise<Body> | null;

let pluginMethods: MethodHandler | null = null;

export const handlePluginSocketMethods = (handler: MethodHandler | null) => void (pluginMethods = handler);

export function setFeedConsumer(key: string, consumer: FeedConsumer | null) {
  if (consumer) consumers.set(key, consumer);
  else consumers.delete(key);
  refreshFeed();
}

function replayLaunch(connection: number) {
  const sub = subscriptions.get(connection);
  if (!sub?.events.has("app.launched") || launchSent.has(connection)) return;
  const launch = launchToReplay();
  if (!launch) return;
  launchSent.add(connection);
  setTimeout(() => {
    if (subscriptions.get(connection)?.events.has("app.launched")) deliver("app.launched", launch.data, launch.time, connection);
  }, 0);
}

export type Body = { result: unknown } | { error: unknown };

export function handleControlRequest({ connection, generation: tagged, line }: ControlRequest) {
  const request = parseRequest(line);
  if ("error" in request) return send(connection, request.id, { error: request.error });
  const { id, method, params } = request;
  if (tagged !== generation || !controlOn()) return send(connection, id, failure("failed", "Control is off."));
  openConnections.add(connection);
  const ticket = method === "run" ? ++nextTicket : 0;
  const caller = callers.get(connection);
  if (ticket && caller) noteControlCaller(caller);
  if (ticket) {
    unwrittenRuns.add(ticket);
    noteSocketRun(1);
  }
  let body: Body | Promise<Body>;
  try {
    body = answer(connection, method, params);
  } catch (error) {
    body = failure("failed", errorText(error));
  }
  const family = familyOf(method);
  const consent = consentToken();
  const reply = (settled: Body) => {
    const line = replyLine(id, settled, method, consent);
    const failedResult = "result" in settled && typeof settled.result === "object" && settled.result !== null && (settled.result as { ok?: unknown }).ok === false;
    noteSocketCall(family, "error" in settled || failedResult || line.startsWith(`{"id":${JSON.stringify(id)},"error":`), consent);
    const replay = takeIdleReplay(connection);
    try {
      replyOnControlSocket(connection, line, ticket);
    } catch (error) {
      runWritten([ticket]);
      throw error;
    }
    for (const data of replay) deliver("tab.idle", data, Date.now(), connection);
  };
  if (body instanceof Promise) void body.then(reply, (error) => reply(failure("failed", errorText(error))));
  else reply(body);
}

export async function windowsWithTargets(windows: AutomationWindow[]): Promise<AutomationWindow[]> {
  const ids = windows.flatMap((w) => w.tabs.map((t) => t.id));
  const targets = ids.length ? await controlTabTargets(ids).catch(() => null) : {};
  if (!targets) return windows;
  return windows.map((w) => ({
    ...w,
    tabs: w.tabs.map((t) => ({ ...t, targetId: targets[t.id]?.targetId ?? null, pageGeneration: targets[t.id]?.pageGeneration ?? 0 })),
  }));
}

export function runMethod(params: Record<string, unknown>, background = backgroundInstance, stillOn: () => boolean = () => true): Body {
  if (background) return failure("refused", "run isn't available in background instances; use the dedicated methods (apply, tabs.*, windows.*, closed.restore, …).");
  const plan = planRun(useBrowser.getState(), params);
  if ("error" in plan) return plan;
  const target = commandTarget(useBrowser.getState(), plan.command, plan.windowId, plan.tabId);
  try {
    refuseSharedRunCommand(plan.command, target.kind === "window" ? target.tabId : null, target.kind === "window" && !!target.targeted);
  } catch (error) {
    return failure("refused", errorText(error));
  }
  try {
    runCommand({ command: plan.command, arg: plan.arg, windowId: plan.windowId }, { strictWindow: plan.windowId !== null, tabId: plan.tabId, mayWrite: stillOn });
  } catch (error) {
    if (error instanceof NoCommandWindowError) return failure("no_window", error.message);
    throw error;
  }
  return { result: { ok: true } };
}

function subscribe(connection: number, params: Record<string, unknown>): Body {
  const sub = parseSubscription(params);
  if ("error" in sub) return sub;
  const served = serveHooks(connection, sub.hooks);
  if ("error" in served) return failure("bad_request", served.error);
  const before = subscriptions.get(connection);
  if (sub.events.size) subscriptions.set(connection, sub);
  else subscriptions.delete(connection);
  refreshFeed();
  const replay = idleToReplay(before, subscriptions.get(connection));
  if (replay.length) idleReplays.set(connection, replay);
  replayLaunch(connection);
  return { result: { ok: true, served: served.served, ...(sub.hooks === undefined || sub.hooks === null ? {} : { revisions: served.revisions }) } };
}

const connectionAccess = (_connection: number): ConnectionAccess => "owner";

function answer(connection: number, method: string, given: Record<string, unknown>): Body | Promise<Body> {
  return guardedBySocketOrigin(methodSpec(method)?.mutates ?? true, (origin) => answerAs(origin, connection, method, given), (message) => failure("refused", message));
}

function answerAs(origin: Pick<SocketOrigin, "segment">, connection: number, method: string, given: Record<string, unknown>): Body | Promise<Body> {
  const spec = methodSpec(method);
  if (!spec) return failure("unknown_method", `There's no method ${method}.`);
  const refused = accessProblem(connectionAccess(connection), spec);
  if (refused) return { error: refused };
  const checked = checkedParams(spec, given);
  if (!("params" in checked)) return checked;
  const { params } = checked;
  const serving = generation;
  const stillOn = () => (origin.segment(), generation === serving && controlOn() && openConnections.has(connection));
  switch (method) {
    case "hello": {
      const tooOld = clientProtocolProblem(params, systemInfo().appVersion);
      if (tooOld) return { error: tooOld };
      const caller = parseControlCaller(params.caller);
      if (caller) callers.set(connection, caller);
      return { result: hello(systemInfo().appVersion) };
    }
    case "caller": {
      const caller = callers.get(connection);
      if (caller) noteControlCaller(caller);
      return { result: { ok: !!caller } };
    }
    case "commands":
      return { result: commands() };
    case "methods":
      return { result: methodsCatalog() };
    case "windows":
      return windowsWithTargets(automationWindows(useBrowser.getState())).then((result) => ({ result }));
    case "workspace":
      return workspaceMethod(params);
    case "offscreen":
      return offscreenMethod(params, stillOn);
    case "apply":
      return applyMethod(params, stillOn, connection);
    case "subscribe":
      return subscribe(connection, params);
    case "answer": {
      const answered = answerDecision(connection, params);
      return "error" in answered ? failure("bad_request", answered.error) : { result: answered };
    }
    case "run":
      return runMethod(params, backgroundInstance, stillOn);
  }
  const area = runSpec(spec, params, servingWhile(stillOn, connection));
  if (area) return area;
  const plugin = pluginMethods?.(method, params, stillOn);
  if (plugin) return plugin;
  return failure("unknown_method", `There's no method ${method}.`);
}

function takeIdleReplay(connection: number) {
  const replay = subscriptions.has(connection) ? (idleReplays.get(connection) ?? []) : [];
  idleReplays.delete(connection);
  return replay;
}

function handleClose({ connection }: { connection: number }) {
  idleReplays.delete(connection);
  openConnections.delete(connection);
  dismissSocketAsks(connection);
  launchSent.delete(connection);
  callers.delete(connection);
  dropResponder(connection);
  dropHistoryHandles(connection);
  dropLateResults(connection);
  if (subscriptions.delete(connection)) refreshFeed();
}

function listen() {
  if (listening) return;
  listening = true;
  onControlRequest((request) => {
    try {
      handleControlRequest(request);
    } catch (error) {
      console.warn("[automation] a request failed", error);
    }
  });
  onControlClose(handleClose);
  onControlWritten(({ tickets }) => runWritten(tickets));
}

async function start(consent: ConsentToken | null) {
  listen();
  const status = await startControlSocket();
  useControlSocket.setState({ status });
  generation = status.state === "on" ? status.generation : null;
  noteSocketServing(generation !== null && controlOn());
  void capturePageMenus(generation !== null).catch(() => undefined);
  if (status.state !== "on") warnFor(consent, `[automation] the control socket is off: ${status.reason ?? "unknown"}`);
}

async function stop() {
  openConnections.clear();
  generation = null;
  dismissSocketAsks();
  dropAllHistoryHandles();
  forgetTabCalls();
  noteSocketServing(false);
  void capturePageMenus(false).catch(() => undefined);
  subscriptions.clear();
  launchSent.clear();
  callers.clear();
  stopResponders();
  refreshFeed();
  await stopControlSocket();
  useControlSocket.setState({ status: null });
}

function sync() {
  const on = controlOn();
  if (on === applied) return;
  applied = on;
  const consent = consentToken();
  if (!on) {
    openConnections.clear();
    generation = null;
    dismissSocketAsks();
    dropAllHistoryHandles();
    forgetTabCalls();
    noteSocketServing(false);
    void capturePageMenus(false).catch(() => undefined);
    stopResponders();
    runWritten([...unwrittenRuns]);
  }
  chain = chain
    .then(() => (on ? start(consent) : stop()))
    .catch((error: unknown) => {
      useControlSocket.setState({ status: { state: "off", generation: 0, path: "", reason: errorText(error) } });
      warnFor(consent, "[automation] the control socket failed", error);
    });
}

let started = false;

export function startAutomation() {
  if (started) return;
  started = true;
  registerSocketAreas();
  startDecideHooks();
  recordLaunch();
  runLaunchActions();
  sync();
  useBrowser.subscribeTo(["settings"], (s, prev) => {
    if (s.settings !== prev.settings) sync();
  });
}
