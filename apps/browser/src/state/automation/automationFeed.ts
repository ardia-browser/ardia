import { startEventFeed, stopEventFeed } from "./automationEvents";
import { CORE_EVENTS, type AutomationEventName } from "./eventNames";
import { startLifecycleEvents, startUserIdleEvents } from "./lifecycleEvents";
import { startStoreEvents, startTabIdle, type EventSend, type TabIdleTracker } from "./storeEvents";
import { setNotificationSink } from "./notificationEvents";
import { startPromptEvents } from "./socketPrompts";
import { startSurfaceEvents } from "./socketSurfaces";
import type { Subscription } from "./automationMethods";

type FeedNeeds = { events: Set<AutomationEventName>; tabIdle: Set<number>; userIdle: Set<number> };

type Family = { key: string; stop: () => void };

const families = new Map<string, Family>();
let tabIdle: TabIdleTracker | null = null;
let coreOn = false;

export function feedNeeds(subscriptions: Iterable<Subscription>): FeedNeeds {
  const needs: FeedNeeds = { events: new Set(), tabIdle: new Set(), userIdle: new Set() };
  for (const sub of subscriptions) {
    for (const name of sub.events) needs.events.add(name);
    if (sub.events.has("tab.idle") || sub.events.has("tab.resumed")) for (const t of sub.tabIdle) needs.tabIdle.add(t);
    for (const t of sub.userIdle) needs.userIdle.add(t);
  }
  return needs;
}

function keep(name: string, key: string | null, start: () => () => void) {
  const current = families.get(name);
  if (current?.key === key) return;
  current?.stop();
  families.delete(name);
  if (key === null) return;
  families.set(name, { key, stop: start() });
}

const sorted = (values: Iterable<string | number>) => [...values].map(String).sort().join(",");

export function updateFeed(needs: FeedNeeds, send: EventSend) {
  const wantsCore = [...needs.events].some((name) => CORE_EVENTS.has(name));
  if (wantsCore && !coreOn) startEventFeed(send);
  if (!wantsCore && coreOn) stopEventFeed();
  coreOn = wantsCore;
  keep("store", needs.events.size ? sorted(needs.events) : null, () => startStoreEvents(send, needs));
  if (needs.tabIdle.size) (tabIdle ??= startTabIdle(send)).watch(needs.tabIdle);
  else stopTabIdle();
  keep("lifecycle", needs.events.size ? sorted(needs.events) : null, () => startLifecycleEvents(send, needs.events));
  keep("notification", needs.events.has("notification.shown") ? "on" : null, () => {
    setNotificationSink(send);
    return () => setNotificationSink(null);
  });
  const prompts = ["permission.prompted", "password.prompted"].filter((name) => needs.events.has(name as AutomationEventName));
  keep("prompts", prompts.length ? prompts.join(",") : null, () => startPromptEvents(send, needs.events));
  keep("surfaces", needs.events.has("menu.opened") ? "on" : null, () => startSurfaceEvents(send));
  keep("userIdle", needs.userIdle.size ? `${sorted(needs.events)}|${sorted(needs.userIdle)}` : null, () => startUserIdleEvents(send, needs.events, needs.userIdle));
}

export function stopFeed() {
  if (coreOn) stopEventFeed();
  coreOn = false;
  for (const family of families.values()) family.stop();
  families.clear();
  stopTabIdle();
}

function stopTabIdle() {
  tabIdle?.stop();
  tabIdle = null;
}

const wantsIdleAt = (sub: Subscription | null | undefined, threshold: number) => !!sub?.events.has("tab.idle") && sub.tabIdle.has(threshold);

export function changeSubscription(before: Subscription | null | undefined, after: Subscription | null | undefined, install: () => void): Record<string, unknown>[] {
  const joining = after ? [...after.tabIdle].filter((t) => wantsIdleAt(after, t) && !wantsIdleAt(before, t)) : [];
  if (joining.length) tabIdle?.catchUp(joining);
  install();
  return joining.flatMap((t) => tabIdle?.idleNow(t) ?? []);
}
