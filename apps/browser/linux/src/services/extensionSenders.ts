import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type IpcMainServiceWorker, type Session } from "electron";
import { acceptsHostNow } from "../ipcSenders";
import { note } from "../log";

type Listener = (event: never, ...args: unknown[]) => unknown;
type SenderEvent = { type?: string; senderFrame?: { url?: string } | null; serviceWorker?: { scope?: string } };

const NAMED_CHANNELS = new Set(["crx-msg", "crx-add-listener", "crx-remove-listener"]);
const REMOTE_CHANNEL = "crx-msg-remote";
const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})(\/|$)/;

const refusals = new Set<string>();

function refuse(channel: string, why: string): void {
  const key = `${channel}:${why}`;
  if (refusals.has(key)) return;
  refusals.add(key);
  note("extensions", `refused ${channel}: ${why}; later refusals like it aren't logged`);
}

export function extensionIdOfSender(event: SenderEvent): string | null {
  const url = event.type === "service-worker" ? (event.serviceWorker?.scope ?? "") : (event.senderFrame?.url ?? "");
  return EXTENSION_ORIGIN.exec(url)?.[1] ?? null;
}

function claimsOwnId(channel: string, event: SenderEvent, claimed: unknown): boolean {
  const own = extensionIdOfSender(event);
  if (own && claimed === own) return true;
  refuse(channel, own ? "an extension named another extension's id" : "the sender isn't an extension page or worker");
  return false;
}

function guard(channel: string, listener: Listener, answersInvoke: boolean): Listener {
  if (channel === REMOTE_CHANNEL)
    return (event, ...args) => {
      if (acceptsHostNow(event as unknown as IpcMainEvent | IpcMainInvokeEvent)) return listener(event, ...args);
      refuse(channel, "only the app's own document may ask across profiles");
      if (answersInvoke) throw new Error(`${channel} isn't available here`);
      return undefined;
    };
  if (!NAMED_CHANNELS.has(channel)) return listener;
  return (event, ...args) => {
    if (claimsOwnId(channel, event as SenderEvent, args[0])) return listener(event, ...args);
    if (answersInvoke) throw new Error(`${channel} was sent for another extension`);
    return undefined;
  };
}

type Registrar = { handle(channel: string, listener: Listener): void; on(channel: string, listener: Listener): unknown };

function guardRegistrar(target: Registrar): () => void {
  const handle = target.handle;
  const on = target.on;
  target.handle = function (channel: string, listener: Listener) {
    return handle.call(this, channel, guard(channel, listener, true));
  };
  target.on = function (channel: string, listener: Listener) {
    return on.call(this, channel, guard(channel, listener, false));
  };
  return () => {
    target.handle = handle;
    target.on = on;
  };
}

export function guardExtensionWorkers(session: Session): void {
  session.serviceWorkers.on("running-status-changed", ({ runningStatus, versionId }) => {
    if (runningStatus !== "starting") return;
    const worker = session.serviceWorkers.getWorkerFromVersionID(versionId);
    const ipc = worker?.ipc as (IpcMainServiceWorker & { ardiaGuarded?: boolean }) | undefined;
    if (!worker?.scope?.startsWith("chrome-extension://") || !ipc || ipc.ardiaGuarded) return;
    ipc.ardiaGuarded = true;
    guardRegistrar(ipc as unknown as Registrar);
  });
}

export function withGuardedExtensionChannels<T>(build: () => T): T {
  const restore = guardRegistrar(ipcMain as unknown as Registrar);
  try {
    return build();
  } finally {
    restore();
  }
}
