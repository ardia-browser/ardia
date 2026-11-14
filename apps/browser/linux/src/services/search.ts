import { defineDomain } from "../engine/domains";
import { extensionSearchEngines } from "./extensions";
import { engineError, sessionFor } from "./profiles";

const MAX_BYTES = 256 * 1024;
const MAX_IN_FLIGHT = 8;
const TIMEOUT_MS = 10_000;
const NET_ERROR_FAILED = -2;
const NET_ERROR_TIMED_OUT = -7;
const NET_ERROR_TOO_BIG = -142;

type Reply = { status: number; body?: string; netError?: number; stopped?: true };
type Pending = { controller: AbortController; settle: (reply: Reply) => void };

const pending = new Map<string, Pending>();
const keyOf = (profile: string, id: number) => `${profile}\n${id}`;

function stop(profile: string, id: number) {
  const key = keyOf(profile, id);
  const running = pending.get(key);
  if (!running) return;
  pending.delete(key);
  running.controller.abort();
  running.settle({ status: 0, stopped: true });
}

async function readCapped(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      void reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function suggest(profile: string, url: string, id: number): Promise<Reply> {
  if (!/^https?:\/\//i.test(url)) throw engineError("a suggestion URL must be http or https");
  if (!Number.isFinite(id) || id < 0) throw engineError("a suggestion request needs an id");
  stop(profile, id);
  while (pending.size >= MAX_IN_FLIGHT) {
    const [oldest] = pending.keys();
    const [owner, oldId] = oldest!.split("\n");
    stop(owner!, Number(oldId));
  }
  return new Promise<Reply>((resolve) => {
    const key = keyOf(profile, id);
    const controller = new AbortController();
    let settled = false;
    const settle = (reply: Reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pending.get(key)?.controller === controller) pending.delete(key);
      resolve(reply);
    };
    const timer = setTimeout(() => {
      controller.abort();
      settle({ status: 0, netError: NET_ERROR_TIMED_OUT });
    }, TIMEOUT_MS);
    pending.set(key, { controller, settle });
    sessionFor(profile)
      .fetch(url, { signal: controller.signal, credentials: "include", headers: { accept: "application/json, text/javascript, */*" } })
      .then(async (response) => {
        if (response.status !== 200) return settle({ status: response.status });
        const body = await readCapped(response);
        settle(body === null ? { status: 200, netError: NET_ERROR_TOO_BIG } : { status: 200, body });
      })
      .catch(() => settle({ status: 0, netError: NET_ERROR_FAILED }));
  });
}

const DEFAULT_ENGINE_NAME = "Google";
let engineName = DEFAULT_ENGINE_NAME;

export const searchEngineName = (): string => engineName;

defineDomain("search", {
  engines: (_args, profile) => ({ list: { engines: extensionSearchEngines(profile) } }),
  setEngineName: (args) => {
    engineName = typeof args.name === "string" && args.name.trim() ? args.name.trim() : DEFAULT_ENGINE_NAME;
    return null;
  },
  suggest: (args, profile) => suggest(profile, typeof args.url === "string" ? args.url : "", typeof args.id === "number" ? args.id : -1),
  stopSuggest: (args, profile) => {
    stop(profile, typeof args.id === "number" ? args.id : -1);
    return null;
  },
});
