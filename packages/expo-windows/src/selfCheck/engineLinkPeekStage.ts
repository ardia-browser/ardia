import { hostCall, onEngineTopic } from "../engine/host";
import { expectEqual, expectTrue, type Check } from "./check";
import { evaluate, LEFT, LINKS_TITLE, listed, painted, pause, show, sleepOnce, withPages } from "./engineSleep";

const SAME_TAB_LINK = { x: 110, y: 30 };
const MOST_TRIES = 3;
const PRESS_MS = 6000;
const PEEK_AFTER_PRESS_MS = 20000;

type PeekConfig = { peek?: unknown; split?: unknown; otherSitePages?: unknown };
type Opened = { disposition?: unknown; url?: unknown };
type PageWindow = { left: number; top: number; width: number; height: number };

const peekConfig = (change: Record<string, unknown>) => hostCall<PeekConfig>("peek.config", change);

async function pageWindow(page: string): Promise<PageWindow> {
  const tab = (await listed(page)) as { left?: unknown; top?: unknown; width?: unknown; height?: unknown } | undefined;
  return { left: Number(tab?.left), top: Number(tab?.top), width: Number(tab?.width), height: Number(tab?.height) };
}

async function screenPoint(page: string, window: PageWindow, point: { x: number; y: number }) {
  const scale = Number(await evaluate(page, 'post("result", JSON.stringify(window.devicePixelRatio));')) || 1;
  return { x: Math.round(window.left + point.x * scale), y: Math.round(window.top + point.y * scale) };
}

async function trustedPresses(page: string): Promise<number> {
  const downs = await evaluate(page, 'post("result", JSON.stringify(window.downs));');
  if (typeof downs !== "number") throw new Error(`the ${page} page's count of trusted presses could not be read (${JSON.stringify(downs)})`);
  return downs;
}

function watchOpened(page: string) {
  const seen: { event: Opened | null } = { event: null };
  const watching = onEngineTopic("tab", (event: { key?: unknown; name?: unknown; data?: Opened }) => {
    if (event.key !== page || event.name !== "openWindow" || seen.event) return;
    seen.event = event.data ?? {};
  });
  return { seen, stop: () => watching.remove() };
}

async function waitFor(ms: number, done: () => Promise<boolean>) {
  const by = Date.now() + ms;
  while (Date.now() < by) {
    if (await done()) return true;
    await pause(200);
  }
  return done();
}

async function realShiftClick(name: string, page: string) {
  const window = await pageWindow(page);
  const at = await screenPoint(page, window, SAME_TAB_LINK);
  const opened = watchOpened(page);
  try {
    let presses = 0;
    let tries = 0;
    while (tries < MOST_TRIES && !opened.seen.event && presses === 0) {
      tries++;
      console.info(`[ardia windows] self-check note: peek stage ready ${name} try ${tries} at ${at.x},${at.y} page window ${window.left},${window.top},${window.width},${window.height}`);
      await waitFor(PRESS_MS, async () => !!opened.seen.event || (presses = await trustedPresses(page)) > 0);
      if (!opened.seen.event && presses === 0) console.info(`[ardia windows] self-check note: peek stage ${name} try ${tries}: no trusted press reached the page within ${PRESS_MS} ms`);
    }
    expectTrue(!!opened.seen.event || presses > 0, `the ${name} page: the real Shift+click never reached the page after ${tries} tries (launch-smoke.ps1 logs why each try missed)`);
    await waitFor(PEEK_AFTER_PRESS_MS, async () => !!opened.seen.event);
    const event = opened.seen.event;
    expectTrue(!!event, `the ${name} page: the real Shift+click reached the page (${presses} trusted presses, try ${tries}) and no Peek came within ${PEEK_AFTER_PRESS_MS} ms`);
    expectEqual(
      { disposition: event?.disposition ?? null, url: String(event?.url ?? "").endsWith("/a") },
      { disposition: "peek", url: true },
      `a real Shift+click (sent by launch-smoke.ps1 with keybd_event and mouse_event, injected input like SendInput, so it passes the host's native mouse-up gate) on the ${name} page's link opens a Peek of it (openWindow ${JSON.stringify(event)}, try ${tries})`,
    );
  } finally {
    opened.stop();
  }
}

async function peeksOnRealClick(name: string, wake: boolean) {
  const before = await peekConfig({});
  try {
    await peekConfig({ peek: "shift" });
    await withPages(
      [name],
      async ([page], windowId) => {
        await show(page!, windowId, LEFT);
        if (wake) await sleepOnce(page!, windowId, LINKS_TITLE);
        else await painted(page!);
        await realShiftClick(name, page!);
      },
      "links",
      LINKS_TITLE,
    );
  } finally {
    await peekConfig({ peek: before.peek, split: before.split, otherSitePages: Array.isArray(before.otherSitePages) ? before.otherSitePages : [] }).catch(() => null);
  }
}

export const linkPeekStage: Check[] = [
  { name: "engine links, real input: a Shift+click on an ordinary page's link opens a Peek", run: () => peeksOnRealClick("ordinary", false) },
  { name: "engine links, real input: a Shift+click on a sandboxed (opaque-origin) page's link opens a Peek", run: () => peeksOnRealClick("sandboxed", false) },
  { name: "engine links, real input: a Shift+click on a page that just woke from sleep opens a Peek", run: () => peeksOnRealClick("woken", true) },
];
