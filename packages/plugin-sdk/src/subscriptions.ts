import { enqueueMicrotask } from "./reconciler";
import { HOST_METHODS as M } from "./protocol";
import { PluginError, type Rpc } from "./rpc";
import type { Registry } from "./types";

export const STATE_PREFIX = "state.";
export const RESYNC_WINDOW_MS = 30_000;
export const MAX_RESYNC_STREAK = 5;
const MAX_RESYNC_DELAY_MS = 60_000;

type Live = () => boolean;
type Timers = { setTimeout?: (callback: () => void, ms: number) => unknown };
export type ResyncOptions = { resyncBackoffMs?: number; now?: () => number };

export function createSubscriptionSync(rpc: Rpc, registry: Registry, report: (error: unknown) => void, live: Live, options: ResyncOptions = {}) {
  let acknowledgedEvents = "";
  let acknowledgedTopics = "";
  let queued = false;
  let inFlight = false;
  let resyncing = false;
  let joined = new Set<string>();
  let waiting = false;
  let streak = 0;
  let lastResyncAt = Number.NEGATIVE_INFINITY;
  let gaveUp = false;
  const now = options.now ?? (() => Date.now());
  const backoff = options.resyncBackoffMs ?? 1000;

  const wantedEvents = () => [...registry.events.keys()].filter((name) => name !== "plugin.values").sort();
  const wantedTopics = () => [...registry.state.keys()].sort();

  const sync = () => {
    if (!live() || queued || inFlight) return;
    queued = true;
    enqueueMicrotask(() => {
      queued = false;
      void send();
    });
  };

  async function send() {
    if (!live() || inFlight) return;
    const events = wantedEvents();
    const signature = events.join(",");
    const topics = wantedTopics();
    const topicSignature = topics.join(",");
    if (signature === acknowledgedEvents && topicSignature === acknowledgedTopics) return;
    inFlight = true;
    let failedEvents = false;
    let failedTopics = false;
    try {
      if (signature !== acknowledgedEvents) {
        try {
          await rpc.request(M.subscribe, { events });
          acknowledgedEvents = signature;
        } catch (error) {
          failedEvents = true;
          report(error);
        }
      }
      if (topicSignature !== acknowledgedTopics) {
        try {
          await rpc.request(M.stateSubscribe, { topics });
          acknowledgedTopics = topicSignature;
          gaveUp = false;
          streak = 0;
        } catch (error) {
          failedTopics = true;
          report(error);
        }
      }
    } finally {
      inFlight = false;
    }
    const eventsMoved = wantedEvents().join(",") !== signature;
    const topicsMoved = wantedTopics().join(",") !== topicSignature;
    if ((!failedEvents && !failedTopics) || eventsMoved || topicsMoved) sync();
  }

  function deliverState(name: string, data: Record<string, unknown>, time: number | undefined) {
    for (const listener of [...(registry.state.get(name.slice(STATE_PREFIX.length)) ?? [])]) {
      try {
        listener(data, { name, time });
      } catch (error) {
        report(error);
      }
    }
  }

  async function resync() {
    waiting = false;
    if (!live() || resyncing || !registry.state.size) return;
    resyncing = true;
    lastResyncAt = now();
    try {
      const topics = wantedTopics();
      await rpc.request(M.stateSubscribe, { topics, resync: true });
      acknowledgedTopics = topics.join(",");
    } catch (error) {
      report(error);
    } finally {
      resyncing = false;
    }
  }

  const later = (ms: number, task: () => void) => {
    const start = (globalThis as Timers).setTimeout;
    if (ms <= 0 || !start) return void enqueueMicrotask(task);
    start(task, ms);
  };

  const noteDropped = (dropped: unknown) => {
    if (typeof dropped !== "number" || !(dropped > 0) || !registry.state.size || gaveUp || waiting || resyncing) return;
    streak = now() - lastResyncAt < RESYNC_WINDOW_MS ? streak + 1 : 0;
    if (streak >= MAX_RESYNC_STREAK) {
      gaveUp = true;
      report(new PluginError("state_desync", `Ardia's channel dropped state events ${MAX_RESYNC_STREAK} times in a row right after a resync, so state events stopped resyncing. Subscribe again to start over.`));
      return;
    }
    waiting = true;
    later(streak === 0 ? 0 : Math.min(backoff * 2 ** (streak - 1), MAX_RESYNC_DELAY_MS), () => void resync());
  };

  const SNAPSHOT_TOPICS = new Set(["tabs", "workspace", "downloads"]);

  async function sendJoined() {
    const topics = [...joined].filter((t) => registry.state.has(t) && acknowledgedTopics.split(",").includes(t));
    joined = new Set();
    if (!live() || !topics.length) return;
    try {
      await rpc.request(M.stateSubscribe, { topics: wantedTopics(), resync: topics });
    } catch (error) {
      report(error);
    }
  }

  const topicJoined = (topic: string) => {
    if (!SNAPSHOT_TOPICS.has(topic)) return;
    if (!joined.size) enqueueMicrotask(() => void sendJoined());
    joined.add(topic);
  };

  const listenerAdded = (topic: string) => {
    if (gaveUp) {
      gaveUp = false;
      streak = 0;
      lastResyncAt = Number.NEGATIVE_INFINITY;
      waiting = true;
      enqueueMicrotask(() => void resync());
      return;
    }
    topicJoined(topic);
  };

  return { sync, deliverState, noteDropped, listenerAdded };
}
