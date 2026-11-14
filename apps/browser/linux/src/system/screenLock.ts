import { powerMonitor } from "electron";
import { count } from "../counts";
import { DBusConnection, type Message, type Variant } from "../engine/dbus";
import { note } from "../log";
import { hostEnvironment } from "../paths";

const LOGIND = "org.freedesktop.login1";
const LOGIND_PATH = "/org/freedesktop/login1";
const LOGIND_MANAGER = "org.freedesktop.login1.Manager";
const LOGIND_SESSION = "org.freedesktop.login1.Session";
const LOGIND_USER = "org.freedesktop.login1.User";
const PROPERTIES = "org.freedesktop.DBus.Properties";
const SCREEN_SAVERS = ["org.freedesktop.ScreenSaver", "org.gnome.ScreenSaver", "org.xfce.ScreenSaver"];

export type SessionLockSource = "logind" | "screenSaver";
export type SessionLockWatch = { sources: SessionLockSource[]; failures: string[]; stop(): void };
export type SessionLockOptions = { systemBus?: string; sessionBus?: string; sessionId?: string; pid?: number; uid?: number; connectDeadlineMs?: number };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function logindSessionPath(bus: DBusConnection, options: SessionLockOptions): Promise<string> {
  const manager = { destination: LOGIND, path: LOGIND_PATH, interface: LOGIND_MANAGER };
  const tries: (() => Promise<string>)[] = [];
  if (options.sessionId) tries.push(async () => String((await bus.call({ ...manager, member: "GetSession", signature: "s", body: [options.sessionId] }))[0]));
  tries.push(async () => String((await bus.call({ ...manager, member: "GetSessionByPID", signature: "u", body: [options.pid ?? process.pid] }))[0]));
  tries.push(async () => {
    const [user] = await bus.call({ ...manager, member: "GetUser", signature: "u", body: [options.uid ?? process.getuid?.() ?? 0] });
    const display = (await bus.getProperty(LOGIND, String(user), LOGIND_USER, "Display")) as [string, string] | undefined;
    if (!display?.[1] || display[1] === "/") throw new Error("the user has no graphical session");
    return display[1];
  });
  let lastError: unknown = new Error("no logind session");
  for (const attempt of tries) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function watchLogind(options: SessionLockOptions, onLock: (source: SessionLockSource) => void): Promise<DBusConnection> {
  const bus = await DBusConnection.system(options.systemBus, options.connectDeadlineMs);
  try {
    const path = await logindSessionPath(bus, options);
    bus.onSignal((message: Message) => {
      if (message.path !== path) return;
      if (message.interface === LOGIND_SESSION && message.member === "Lock") return onLock("logind");
      if (message.interface !== PROPERTIES || message.member !== "PropertiesChanged" || message.body[0] !== LOGIND_SESSION) return;
      const changed = message.body[1] as Record<string, Variant> | undefined;
      if (changed?.LockedHint?.value === true) return onLock("logind");
      if (!(message.body[2] as string[] | undefined)?.includes("LockedHint")) return;
      void bus.getProperty(LOGIND, path, LOGIND_SESSION, "LockedHint").then((locked) => locked === true && onLock("logind"), () => undefined);
    });
    await bus.addMatch(`type='signal',sender='${LOGIND}',path='${path}',interface='${LOGIND_SESSION}',member='Lock'`);
    await bus.addMatch(`type='signal',sender='${LOGIND}',path='${path}',interface='${PROPERTIES}',member='PropertiesChanged',arg0='${LOGIND_SESSION}'`);
    return bus;
  } catch (error) {
    bus.close();
    throw error;
  }
}

async function watchScreenSavers(options: SessionLockOptions, onLock: (source: SessionLockSource) => void): Promise<DBusConnection> {
  const bus = await DBusConnection.session(options.sessionBus, options.connectDeadlineMs);
  try {
    bus.onSignal((message: Message) => {
      if (message.member === "ActiveChanged" && SCREEN_SAVERS.includes(message.interface ?? "") && message.body[0] === true) onLock("screenSaver");
    });
    for (const screenSaver of SCREEN_SAVERS) await bus.addMatch(`type='signal',interface='${screenSaver}',member='ActiveChanged'`);
    return bus;
  } catch (error) {
    bus.close();
    throw error;
  }
}

export async function watchSessionLock(onLock: (source: SessionLockSource) => void, options: SessionLockOptions = {}): Promise<SessionLockWatch> {
  const settings = { sessionId: hostEnvironment.sessionId ?? undefined, ...options };
  const watchers: [SessionLockSource, Promise<DBusConnection>][] = [
    ["logind", watchLogind(settings, onLock)],
    ["screenSaver", watchScreenSavers(settings, onLock)],
  ];
  const settled = await Promise.allSettled(watchers.map(([, watching]) => watching));
  const sources: SessionLockSource[] = [];
  const failures: string[] = [];
  const connections: DBusConnection[] = [];
  settled.forEach((result, index) => {
    const source = watchers[index]![0];
    if (result.status === "fulfilled") {
      sources.push(source);
      connections.push(result.value);
    } else failures.push(`${source}: ${errorText(result.reason)}`);
  });
  return { sources, failures, stop: () => connections.forEach((connection) => connection.close()) };
}

const lockListeners = new Set<() => void>();
let watching = false;
let watch: Promise<SessionLockWatch | null> = Promise.resolve(null);

export const sessionLockWatch = (): Promise<SessionLockWatch | null> => watch;

function screenLocked() {
  for (const listener of lockListeners) {
    try {
      listener();
    } catch (error) {
      note("screenLock", `a lock listener failed: ${errorText(error)}`);
    }
  }
}

export function whenScreenLocks(listener: () => void): void {
  lockListeners.add(listener);
  if (watching) return;
  watching = true;
  powerMonitor.on("lock-screen", screenLocked);
  watch = watchSessionLock((source) => {
    count("screen_locks_seen");
    note("screenLock", `the session locked (${source})`);
    screenLocked();
  }).then(
    (started) => {
      if (!started.sources.length) count("screen_lock_watch_unavailable");
      note("screenLock", `watching for the session lock through ${started.sources.join(" and ") || "nothing"}${started.failures.length ? ` (${started.failures.join("; ")})` : ""}`);
      return started;
    },
    (error) => {
      note("screenLock", `can't watch for the session lock: ${errorText(error)}`);
      return null;
    },
  );
}
