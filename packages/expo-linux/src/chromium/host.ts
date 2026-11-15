import { callMain, callMainSync, mainModules } from "../bridge";
import { addNativeListener } from "../events";

type EngineEvent = { topic?: unknown; json?: unknown };
type TopicListener = (payload: Record<string, unknown>) => void;

export const ENGINE_HOST = "ArdiaEngineHost";

const listeners = new Map<string, Set<TopicListener>>();
const shown = new Map<string, Record<string, unknown>>();
let subscribed = false;
let hostCalls = 0;

Object.assign(globalThis, { ardiaEngineDebug: { shown: () => Object.fromEntries(shown), hostCalls: () => hostCalls } });

export const engineAvailable = (): boolean => !!mainModules()[ENGINE_HOST];

export class EngineError extends Error {
  code = "ERR_ENGINE";
}

function decode<Result>(json: unknown): Result {
  if (typeof json !== "string") throw Object.assign(new EngineError("the engine's reply isn't JSON"), { code: "ERR_BAD_REPLY" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw Object.assign(new EngineError("the engine's reply isn't JSON"), { code: "ERR_BAD_REPLY" });
  }
  const failure = (parsed as { error?: unknown } | null)?.error;
  if (typeof failure === "string") throw new EngineError(failure);
  return parsed as Result;
}

function present() {
  if (!engineAvailable()) throw new EngineError("no engine");
}

export async function hostCall<Result = unknown>(verb: string, args: Record<string, unknown> = {}, windowId = ""): Promise<Result> {
  present();
  hostCalls += 1;
  if (verb === "tab.show" && typeof args.key === "string") shown.set(args.key, { ...args, windowId });
  if (verb === "tab.close" && typeof args.key === "string") shown.delete(args.key);
  return decode<Result>(await callMain<string>(ENGINE_HOST, "hostCall", verb, JSON.stringify(args), windowId));
}

export async function engineCallJson(name: string, profile: string, argsJson: string): Promise<string> {
  present();
  const reply = await callMain<string>(ENGINE_HOST, "engineCall", name, profile, argsJson);
  if (typeof reply !== "string") throw Object.assign(new EngineError("the engine's reply isn't JSON"), { code: "ERR_BAD_REPLY" });
  return reply;
}

export type ProfileFolderRemoval = "removed" | "absent" | "inUse" | "partial" | "refused" | "failed" | "unsupported";

const REMOVALS: readonly ProfileFolderRemoval[] = ["removed", "absent", "inUse", "partial", "refused", "failed"];

export function profileDataFolder(): string | null {
  const constant = mainModules()[ENGINE_HOST]?.constants?.profileDataFolder;
  const folder = typeof constant === "string" ? constant : callMainSync<string>(ENGINE_HOST, "profileDataFolder");
  return typeof folder === "string" && folder ? folder : null;
}

export async function removeProfileFolder(folder: string): Promise<ProfileFolderRemoval> {
  const shape = mainModules()[ENGINE_HOST];
  if (!shape?.async.includes("removeProfileFolder")) return "unsupported";
  const outcome = await callMain<string>(ENGINE_HOST, "removeProfileFolder", folder);
  return REMOVALS.find((known) => known === outcome) ?? "failed";
}

function deliver(raw: unknown) {
  const event = raw as EngineEvent | null;
  if (typeof event?.topic !== "string" || typeof event.json !== "string") return;
  const wanted = listeners.get(event.topic);
  if (!wanted?.size) return;
  let payload: unknown;
  try {
    payload = JSON.parse(event.json);
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") return;
  for (const listener of [...wanted]) listener(payload as Record<string, unknown>);
}

export function onEngineTopic(topic: string, listener: TopicListener): { remove(): void } {
  if (!subscribed) {
    subscribed = true;
    addNativeListener(ENGINE_HOST, "event", deliver);
  }
  let wanted = listeners.get(topic);
  if (!wanted) listeners.set(topic, (wanted = new Set()));
  wanted.add(listener);
  return { remove: () => void wanted.delete(listener) };
}
