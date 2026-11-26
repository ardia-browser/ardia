import { errorText } from "../../lib/errors";
import { controlCancel, controlCancelAll, controlDevToolsClose, controlDevToolsOpen, controlDevToolsSend, onControlDevTools, type ControlDevToolsEvent } from "../../platform/control";
import { setInspectionTransport, TRANSPORT_LOSS, type CdpEventListener, type CdpParams, type TransportOpener } from "./devToolsSession";
import { STOPPED } from "./socketCatalog";
import { broadcastOnControlSocket } from "../../platform/automation";
import { fittedEvent } from "./socketWire";
import { OpError } from "./workspaceTargets";
import { consentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";

const cancelFailed = (what: string) => (error: unknown) => warnFor(consentToken(), `[automation] the engine didn't cancel ${what}`, error);

export type EngineCliPush = (connection: number, name: "devtools.event" | "devtools.detached", data: Record<string, unknown>) => void;

type SocketSession = { connection: number; tab: string; targetId: string };

let epoch = 0;
let push: EngineCliPush | null = null;
let subscription: { remove(): void } | null = null;
const socketSessions = new Map<number, SocketSession>();
const inspectListeners = new Map<number, Set<CdpEventListener>>();
const inspectClosed = new Map<number, () => void>();

export const ownerOf = (connection: number) => `s${epoch}c${connection}`;
const inspectOwner = () => `s${epoch}inspect`;

export const engineFailure = (error: unknown) => (error instanceof OpError ? error : new OpError("failed", errorText(error)));

function route(event: ControlDevToolsEvent) {
  const session = event.session;
  if (typeof session !== "number") return;
  if (event.closed !== undefined) {
    const owned = socketSessions.get(session);
    socketSessions.delete(session);
    inspectListeners.delete(session);
    const closed = inspectClosed.get(session);
    inspectClosed.delete(session);
    closed?.();
    if (owned) push?.(owned.connection, "devtools.detached", { session, reason: event.closed });
    return;
  }
  if (typeof event.method !== "string") return;
  const listeners = inspectListeners.get(session);
  if (listeners) {
    const lost = event.cut === true || (event.dropped ?? 0) > 0 || (event.droppedByHost ?? 0) > 0;
    if (lost) for (const listener of [...listeners]) listener(TRANSPORT_LOSS, {});
    if (!event.cut) for (const listener of [...listeners]) listener(event.method, (event.params ?? {}) as CdpParams);
    return;
  }
  const owned = socketSessions.get(session);
  if (!owned) return;
  push?.(owned.connection, "devtools.event", {
    session,
    method: event.method,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.cut ? { cut: true, bytes: event.bytes ?? 0 } : { params: event.params ?? {} }),
    ...((event.dropped ?? 0) > 0 ? { dropped: event.dropped } : {}),
    ...((event.droppedByHost ?? 0) > 0 ? { droppedByHost: event.droppedByHost } : {}),
  });
}

export function startEngineCli(pusher: EngineCliPush) {
  push = pusher;
  subscription ??= onControlDevTools(route);
}

export function installEngineCli(isOpen: (connection: number) => boolean) {
  startEngineCli((connection, name, data) => {
    if (isOpen(connection)) broadcastOnControlSocket([connection], fittedEvent(name, Date.now(), data, consentToken()));
  });
  setInspectionTransport(engineInspectionOpener);
}

export function stopEngineCli() {
  subscription?.remove();
  subscription = null;
  push = null;
}

export async function attachSession(connection: number, tab: string, serving: () => boolean) {
  const startedIn = epoch;
  const owner = ownerOf(connection);
  const opened = await controlDevToolsOpen(tab, owner, "full").catch((error: unknown) => {
    throw engineFailure(error);
  });
  if (epoch !== startedIn || !serving()) {
    void controlDevToolsClose(opened.session, owner).catch(cancelFailed("a session opened as control stopped"));
    throw new OpError("failed", STOPPED);
  }
  socketSessions.set(opened.session, { connection, tab, targetId: opened.targetId });
  return opened;
}

export function ownedSession(connection: number, session: number): SocketSession {
  const owned = socketSessions.get(session);
  if (!owned || owned.connection !== connection) throw new OpError("no_window", `There's no DevTools session ${session} on this connection.`);
  return owned;
}

export async function sendOn(connection: number, send: { session: number; method: string; params?: Record<string, unknown>; sessionId?: string; timeoutMs?: number }) {
  ownedSession(connection, send.session);
  return await controlDevToolsSend({ ...send, owner: ownerOf(connection) }).catch((error: unknown) => {
    throw engineFailure(error);
  });
}

export async function detachSession(connection: number, session: number) {
  ownedSession(connection, session);
  socketSessions.delete(session);
  const closed = await controlDevToolsClose(session, ownerOf(connection)).catch(() => ({ closed: false }));
  return { closed: closed.closed };
}

export const sessionsOf = (connection: number) =>
  [...socketSessions.entries()].filter(([, owned]) => owned.connection === connection).map(([session, owned]) => ({ session, tab: owned.tab, targetId: owned.targetId }));

export function closeEngineCliFor(connection: number) {
  for (const [session, owned] of [...socketSessions]) if (owned.connection === connection) socketSessions.delete(session);
  void controlCancel(ownerOf(connection)).catch(cancelFailed("a closed connection's work"));
}

export function closeAllEngineCli() {
  socketSessions.clear();
  void controlCancelAll().catch(cancelFailed("its work when control stopped"));
  epoch++;
}

export const liveEngineSessions = () => socketSessions.size;

export const engineInspectionOpener: TransportOpener = async (tabId) => {
  const owner = inspectOwner();
  const opened = await controlDevToolsOpen(tabId, owner, "inspect").catch((error: unknown) => {
    throw engineFailure(error);
  });
  const listeners = new Set<CdpEventListener>();
  const closedListeners = new Set<() => void>();
  inspectListeners.set(opened.session, listeners);
  inspectClosed.set(opened.session, () => {
    for (const listener of [...closedListeners]) listener();
  });
  return {
    send: async (method, params) => (await controlDevToolsSend({ session: opened.session, owner, method, params }).catch((error: unknown) => {
      throw engineFailure(error);
    })).result,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    onClosed: (listener) => {
      closedListeners.add(listener);
      return () => void closedListeners.delete(listener);
    },
    close: async () => {
      inspectListeners.delete(opened.session);
      inspectClosed.delete(opened.session);
      await controlDevToolsClose(opened.session, owner).catch(() => undefined);
    },
  };
};
