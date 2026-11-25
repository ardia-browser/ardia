import { sendToPlugin } from "../../platform/plugins";
import { grantsTopic, isStateTopic, STATE_TOPICS, type StateTopic } from "../../lib/pluginState";
import type { PluginManifest } from "../../lib/pluginManifest";
import { useBrowser, type BrowserState } from "../browser/store";
import { useDownloadProgress } from "../downloads/progress";
import { failure } from "../automation/automationMethods";
import type { Body } from "../automation/controlSocket";
import { notePlugin, notePluginTimes } from "../telemetry/pluginCounts";
import { consentToken, stillValid, type ConsentToken } from "../telemetry/choice";
import { warnFor } from "../telemetry/consoleConsent";
import { acceptsRun } from "./process";
import { activeManifest, currentPlugins } from "./store";
import { commitCursor, commitsAfter, forgetCommitsThrough, listenForPluginStateCommits } from "./stateCommits";
import { packFrames, takeRound, wireLine, type Frame } from "./stateEventPacking";
import { commitItems, diffRows, itemsFor, REMOVED, rowsOf, type Rows, type Sent, type SnapshotTopic } from "./stateProjection";
import { redactionFor, type Redaction } from "./pluginEventRedaction";

export const STATE_FLUSH_MS = 100;
const SLOW_FLUSH_MS = 16;

type Caller = { name: string; run: number };
type Queued = Frame & { settles: [string, string | null][]; consent: ConsentToken | null };
type Subscriber = Caller & { topics: Set<StateTopic>; sent: Map<StateTopic, Sent>; outbox: Queued[]; cursor: number };

const subscribers = new Map<string, Subscriber>();
let dirty = new Set<StateTopic>();
let timer: ReturnType<typeof setTimeout> | null = null;
let stopWatching: (() => void) | null = null;
let stopWatchingProgress: (() => void) | null = null;

const keyOf = (c: Caller) => `${c.name}#${c.run}`;

function scheduleFlush() {
  if (!timer && subscribers.size) timer = setTimeout(flushStateEvents, STATE_FLUSH_MS);
}

function markDirty(topics: Iterable<StateTopic>) {
  for (const topic of topics) dirty.add(topic);
  if (dirty.size) scheduleFlush();
}

function onCommit(s: BrowserState, prev: BrowserState) {
  const topics: StateTopic[] = [];
  const layout = s.tabs !== prev.tabs || s.windows !== prev.windows || s.windowOrder !== prev.windowOrder || s.groups !== prev.groups || s.peeks !== prev.peeks;
  if (layout) topics.push("tabs", "workspace");
  else if (s.ui.focusOrder !== prev.ui.focusOrder) topics.push("workspace");
  if (s.downloads !== prev.downloads || s.profiles !== prev.profiles) topics.push("downloads");
  if (topics.length) markDirty(topics);
}

const onPageCommit = () => markDirty(["navigation"]);

const wantsCommits = () => [...subscribers.values()].some((sub) => sub.topics.has("navigation"));

function syncWatching() {
  if (subscribers.size) stopWatching ??= useBrowser.subscribeTo(["tabs", "windows", "windowOrder", "groups", "peeks", "ui", "downloads", "profiles"], onCommit);
  if (subscribers.size) stopWatchingProgress ??= useDownloadProgress.subscribe(() => markDirty(["downloads"]));
  listenForPluginStateCommits(wantsCommits() ? onPageCommit : null);
  if (subscribers.size) return;
  stopWatching?.();
  stopWatching = null;
  stopWatchingProgress?.();
  stopWatchingProgress = null;
  dirty = new Set();
  if (timer) clearTimeout(timer);
  timer = null;
}

const SUBSCRIBE_KEYS = ["topics", "resync"];

export function subscribeState(c: Caller, m: PluginManifest, params: Record<string, unknown>): Body {
  const unknown = Object.keys(params).filter((key) => !SUBSCRIBE_KEYS.includes(key));
  if (unknown.length) return failure("bad_request", `state.subscribe takes topics and resync, not ${unknown.slice(0, 4).map((k) => k.slice(0, 40)).join(", ")}.`);
  const askedResync = params.resync;
  if (askedResync !== undefined && typeof askedResync !== "boolean" && !(Array.isArray(askedResync) && askedResync.length <= STATE_TOPICS.length && askedResync.every(isStateTopic))) {
    return failure("bad_request", "resync is true, false or a list of the topics to send whole again.");
  }
  const given = params.topics;
  if (!Array.isArray(given) || given.length > STATE_TOPICS.length * 2) return failure("bad_request", `state.subscribe needs topics: a list of ${STATE_TOPICS.join(", ")}.`);
  const bad = given.findIndex((t) => !isStateTopic(t));
  if (bad >= 0) return failure("bad_request", `topics[${bad}] isn't one of ${STATE_TOPICS.join(", ")}.`);
  const topics = new Set(given as StateTopic[]);
  const refused = [...topics].filter((t) => !grantsTopic(m.permissions.state, t));
  if (refused.length) {
    notePlugin("plugin_state_subscribe_refusals", consentToken());
    return failure("refused", `This plugin's permissions.state.events don't list ${refused.join(", ")}.`);
  }
  const key = keyOf(c);
  const existing = subscribers.get(key);
  if (!topics.size) {
    subscribers.delete(key);
    syncWatching();
    return { result: { ok: true, topics: [] } };
  }
  const sub: Subscriber = existing ?? { name: c.name, run: c.run, topics, sent: new Map(), outbox: [], cursor: commitCursor() };
  const resyncing = new Set<StateTopic>(askedResync === true ? topics : Array.isArray(askedResync) ? (askedResync as StateTopic[]).filter((t) => topics.has(t)) : []);
  if (askedResync === true && existing) notePlugin("plugin_state_resyncs", consentToken());
  for (const topic of [...sub.sent.keys()]) if (!topics.has(topic) || resyncing.has(topic)) sub.sent.delete(topic);
  sub.outbox = sub.outbox.filter((f) => topics.has(f.topic as StateTopic) && !resyncing.has(f.topic as StateTopic));
  const added = [...topics].filter((t) => resyncing.has(t) || !existing || !sub.topics.has(t));
  if (topics.has("navigation") && (!existing || !sub.topics.has("navigation"))) sub.cursor = commitCursor();
  sub.topics = topics;
  subscribers.set(key, sub);
  syncWatching();
  markDirty(added);
  return { result: { ok: true, topics: [...topics] } };
}

export function dropStateSubscriptions(name: string) {
  for (const [key, sub] of subscribers) if (sub.name === name) subscribers.delete(key);
  syncWatching();
}

export const stateSubscriberCount = () => subscribers.size;

function settlesFor(frame: Frame, signatures: Sent): [string, string | null][] {
  return frame.completes.map((key): [string, string | null] => (key.startsWith(REMOVED) ? [key.slice(REMOVED.length), null] : [key, signatures.get(key)!]));
}

function queueTopic(sub: Subscriber, topic: StateTopic, s: BrowserState, r: Redaction, cache: Map<string, Rows>, consent: ConsentToken | null) {
  if (topic === "navigation") {
    const items = commitItems(s, commitsAfter(sub.cursor), r);
    sub.cursor = commitCursor();
    for (const frame of items.length ? packFrames(topic, ["commits"], items, { initial: false }) : []) {
      const tokens = frame.tags as (ConsentToken | null)[];
      sub.outbox.push({ ...frame, settles: [], consent: tokens.find((t) => stillValid(t)) ?? null });
    }
    return;
  }
  const diff = diffRows(sub.sent.get(topic), rowsOf(topic as SnapshotTopic, s, r, cache));
  if (diff.before && !diff.changed.length && !diff.removed.length) return;
  const { fields, items } = itemsFor(diff, topic as SnapshotTopic);
  for (const frame of packFrames(topic, fields, items, { initial: !diff.before })) sub.outbox.push({ ...frame, settles: settlesFor(frame, diff.signatures), consent });
}

type Counts = Map<ConsentToken | null, number>;

function sendFrame(sub: Subscriber, frame: Queued, more: boolean, time: number, counts: Counts) {
  const topic = frame.topic as StateTopic;
  sendToPlugin(sub.name, sub.run, wireLine(topic, time, more ? { ...frame.data, more: true } : frame.data));
  if (topic !== "navigation") {
    const sent = sub.sent.get(topic) ?? new Map<string, string>();
    for (const [key, sig] of frame.settles) {
      if (sig === null) sent.delete(key);
      else sent.set(key, sig);
    }
    sub.sent.set(topic, sent);
  }
  counts.set(frame.consent, (counts.get(frame.consent) ?? 0) + 1);
}

function drain(sub: Subscriber, time: number, counts: Counts, consent: ConsentToken | null) {
  const failed = new Set<string>();
  for (const { frame, more } of takeRound(sub.outbox)) {
    if (failed.has(frame.topic)) continue;
    try {
      sendFrame(sub, frame, more, time, counts);
    } catch (error) {
      failed.add(frame.topic);
      sub.sent.delete(frame.topic as StateTopic);
      sub.outbox = sub.outbox.filter((f) => f.topic !== frame.topic);
      notePlugin("plugin_state_events_dropped", consent);
      warnFor(consent, "[plugins] a state event couldn't be sent", error);
    }
  }
}

function flushFor(sub: Subscriber, topics: Set<StateTopic>, s: BrowserState, cache: Map<string, Rows>, time: number, counts: Counts, consent: ConsentToken | null) {
  const m = activeManifest(currentPlugins(), sub.name);
  if (!m || !acceptsRun(sub.name, sub.run)) {
    subscribers.delete(keyOf(sub));
    return;
  }
  const r = redactionFor(m.permissions);
  for (const topic of sub.topics) {
    if (!topics.has(topic) || !grantsTopic(m.permissions.state, topic)) continue;
    if (sub.outbox.some((f) => f.topic === topic)) {
      dirty.add(topic);
      continue;
    }
    try {
      queueTopic(sub, topic, s, r, cache, consent);
    } catch (error) {
      sub.sent.delete(topic);
      notePlugin("plugin_state_events_dropped", consent);
      warnFor(consent, "[plugins] a state event couldn't be built", error);
    }
  }
  drain(sub, time, counts, consent);
}

export function flushStateEvents() {
  timer = null;
  const topics = dirty;
  dirty = new Set();
  const waiting = [...subscribers.values()].some((sub) => sub.outbox.length);
  if ((!topics.size && !waiting) || !subscribers.size) return;
  const started = Date.now();
  const consent = consentToken();
  const s = useBrowser.getState();
  const cache = new Map<string, Rows>();
  const counts: Counts = new Map();
  for (const sub of [...subscribers.values()]) flushFor(sub, topics, s, cache, started, counts, consent);
  for (const [token, times] of counts) if (token !== null) notePluginTimes("plugin_state_events", times, token);
  if (Date.now() - started > SLOW_FLUSH_MS) notePlugin("plugin_state_flushes_slow", consent);
  const readers = [...subscribers.values()].filter((sub) => sub.topics.has("navigation"));
  if (readers.length) forgetCommitsThrough(Math.min(...readers.map((sub) => sub.cursor)));
  if ([...subscribers.values()].some((sub) => sub.outbox.length) || dirty.size) scheduleFlush();
  syncWatching();
}
