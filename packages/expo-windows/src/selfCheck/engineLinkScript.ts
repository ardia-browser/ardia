import { engineAvailable, hostCall, onEngineTopic } from "../engine/host";
import { httpPagesPort } from "./engineBackForward";
import { expectEqual, expectTrue, type Check } from "./check";
import { click, evaluate, firstWindow, hide, LEFT, LINKS_TITLE, listed, loaded, pause, show, sleepOnce, timedCall, until, withPages } from "./engineSleep";

const WAKES = 20;
const QUICK_CLOSES = 10;
const NAVIGATIONS = 10;
const OPEN_MS = 3000;
const LOAD_MS = 20000;
const BLANK_LINK = { x: 110, y: 90 };
const FRESH_TABS = 50;
const DISCARD_WAKES = 50;

type Paint = "before" | "after" | "unknown";
type Round = { received: boolean; opened: boolean; fromClick: unknown; paint: Paint };

const CONTENTFUL_PAINT_AT = 'const paint = performance.getEntriesByName("first-contentful-paint")[0]; post("result", JSON.stringify(paint ? performance.timeOrigin + (paint.paintTime ?? paint.startTime) : null));';

async function clickAtOnce(page: string): Promise<Round> {
  let opened = false;
  let fromClick: unknown = null;
  let dispatchedAt: unknown = null;
  const watching = onEngineTopic("tab.opened", (event: { opener?: unknown; fromClick?: unknown; adopt?: unknown }) => {
    if (event.opener !== page || opened) return;
    opened = true;
    fromClick = event.fromClick;
    if (typeof event.adopt === "string") void hostCall("tab.discard", { adopt: event.adopt }).catch(() => null);
  });
  try {
    dispatchedAt = ((await click(page, BLANK_LINK.x, BLANK_LINK.y)) as { dispatchedAt?: unknown } | null)?.dispatchedAt ?? null;
    const by = Date.now() + OPEN_MS;
    while (!opened && Date.now() < by) await pause(50);
  } finally {
    watching.remove();
  }
  const downs = await evaluate(page, 'post("result", JSON.stringify(window.downs));').catch((error: unknown) => {
    throw new Error(`the ${page} page's count of trusted presses could not be read: ${String((error as Error)?.message ?? error)}`);
  });
  if (typeof downs !== "number") throw new Error(`the ${page} page's count of trusted presses could not be read (${JSON.stringify(downs)})`);
  const paintedAt = await evaluate(page, CONTENTFUL_PAINT_AT).catch(() => null);
  expectTrue(typeof dispatchedAt === "number" && Number.isFinite(dispatchedAt), `clickForTest answers when it dispatched the press to the renderer (dispatchedAt): ${JSON.stringify(dispatchedAt)}`);
  const paint: Paint = typeof paintedAt !== "number" ? "unknown" : dispatchedAt < paintedAt ? "before" : "after";
  return { received: downs > 0, opened, fromClick, paint };
}

function counted(rounds: Round[], what: string) {
  const missed = rounds.filter((round) => round.received && !(round.opened && round.fromClick === true)).length;
  const lost = rounds.filter((round) => !round.received);
  const reached = rounds.length - lost.length;
  const lostBy = (paint: Paint) => lost.filter((round) => round.paint === paint).length;
  console.info(
    `[ardia windows] self-check note: link script rounds, ${what}: ${reached} of ${rounds.length} clicks delivered (reached the page as a trusted press), ${missed} of those missed by the link script, ${lost.length} never reached it (sent ${lostBy("before")} before first contentful paint, ${lostBy("after")} after it, ${lostBy("unknown")} with no paint entry; first contentful paint is not when the browser starts accepting input, so these are data, not a verdict)`,
  );
  return { missed, reached };
}

function judge(rounds: Round[], what: string) {
  const { missed, reached } = counted(rounds, what);
  expectEqual(
    { missed, mostReached: reached * 2 >= rounds.length },
    { missed: 0, mostReached: true },
    `${what}: every click the page received opened a tab its link script saw, and at least half reached the page (${reached} of ${rounds.length} delivered) ${JSON.stringify(rounds)}`,
  );
}

async function freshRound(port: string, windowId: string, index: number): Promise<Round> {
  const key = `self-check-links-fresh-${index}`;
  await timedCall("tab.create", { key, url: `http://127.0.0.1:${port}/links?fresh${index}`, profile: "" }, windowId);
  try {
    await timedCall("tab.show", { key, visible: true, ...LEFT }, windowId);
    await loaded(key, LINKS_TITLE);
    return await clickAtOnce(key);
  } finally {
    await timedCall("tab.close", { key });
  }
}

async function discardedAndWoken(page: string, windowId: string) {
  await hide(page, windowId);
  const outcome = (await timedCall<{ outcome?: unknown }>("tab.call", { key: page, method: "discard" })).outcome;
  expectEqual(outcome, "discarded", "the hidden page is discarded");
  await show(page, windowId, LEFT);
  await loaded(page, LINKS_TITLE);
}

async function navigated(page: string, url: string, what: string) {
  await hostCall("tab.call", { key: page, method: "loadUrl", url });
  await until(`the page ${page} shows ${what}`, LOAD_MS, () => listed(page), (tab) => String(tab?.url) === url && tab?.title === LINKS_TITLE && tab.loading === false);
}

const linkScriptChecks = (port: string): Check[] => [
  {
    name: "engine links: tabs closed before their link script finishes registering, some before the tab even answers, all close, and the engine keeps answering",
    run: async () => {
      const windowId = await firstWindow();
      const keys: string[] = [];
      for (let i = 0; i < QUICK_CLOSES; i++) {
        const key = `self-check-links-quick-close-${i}`;
        keys.push(key);
        const created = timedCall("tab.create", { key, url: `http://127.0.0.1:${port}/links?quick${i}`, profile: "" }, windowId);
        if (i % 2 === 0) {
          const early = timedCall("tab.close", { key });
          await created.catch(() => null);
          await early;
        } else {
          await created;
        }
        await timedCall("tab.close", { key });
      }
      const tabs = (await timedCall<{ tabs?: { key: string }[] }>("tabs.list")).tabs ?? [];
      expectTrue(!tabs.some((tab) => keys.includes(tab.key)), `every quickly closed tab is gone (${JSON.stringify(tabs.map((tab) => tab.key))})`);
    },
  },
  {
    name: "engine links: the link script sees the first click on a page that just woke from sleep",
    run: () =>
      withPages(
        ["first-click"],
        async ([page], windowId) => {
          await show(page!, windowId, LEFT);
          const rounds: Round[] = [];
          for (let i = 0; i < WAKES; i++) {
            await sleepOnce(page!, windowId, LINKS_TITLE);
            rounds.push(await clickAtOnce(page!));
          }
          judge(rounds, "clicks at once after a wake");
        },
        "links",
        LINKS_TITLE,
      ),
  },
  {
    name: "engine links: the link script sees the first click on a page reached by a cross-process navigation",
    run: () =>
      withPages(
        ["cross-process"],
        async ([page], windowId) => {
          await show(page!, windowId, LEFT);
          const rounds: Round[] = [];
          for (let i = 0; i < NAVIGATIONS; i++) {
            const host = i % 2 === 0 ? "localhost" : "127.0.0.1";
            await navigated(page!, `http://${host}:${port}/links?round${i}`, host);
            rounds.push(await clickAtOnce(page!));
          }
          judge(rounds, "clicks at once after a cross-process navigation");
        },
        "links",
        LINKS_TITLE,
      ),
  },
  {
    name: "engine links: the link script sees the first click on a page reached by a same-site navigation while the page before waits in the back/forward cache",
    run: () =>
      withPages(
        ["same-site"],
        async ([page], windowId) => {
          await show(page!, windowId, LEFT);
          const rounds: Round[] = [];
          for (let i = 0; i < NAVIGATIONS; i++) {
            await navigated(page!, `http://127.0.0.1:${port}/links?same${i}`, `the same-site page ${i}`);
            rounds.push(await clickAtOnce(page!));
          }
          judge(rounds, "clicks at once after a same-site navigation");
        },
        "links",
        LINKS_TITLE,
      ),
  },
  {
    name: "engine links: on freshly created tabs, every click the page received opened a tab its link script saw, and at least half of 50 reached the page (50 tabs, counts logged)",
    run: async () => {
      const windowId = await firstWindow();
      const rounds: Round[] = [];
      for (let i = 0; i < FRESH_TABS; i++) rounds.push(await freshRound(port, windowId, i));
      judge(rounds, "link script first document, clicks at once on a freshly created tab");
      expectTrue(Array.isArray((await timedCall<{ tabs?: unknown }>("tabs.list")).tabs), "the engine still lists tabs");
    },
  },
  {
    name: "engine links: on a tab discarded and woken, every click the page received opened a tab its link script saw, and at least half of 50 reached the page (50 wakes, counts logged)",
    run: () =>
      withPages(
        ["discard-wake"],
        async ([page], windowId) => {
          await show(page!, windowId, LEFT);
          const rounds: Round[] = [];
          for (let i = 0; i < DISCARD_WAKES; i++) {
            await discardedAndWoken(page!, windowId);
            rounds.push(await clickAtOnce(page!));
          }
          judge(rounds, "link script first document, clicks at once on a tab discarded and woken");
          expectTrue(Array.isArray((await timedCall<{ tabs?: unknown }>("tabs.list")).tabs), "the engine still lists tabs");
        },
        "links",
        LINKS_TITLE,
      ),
  },
];

const port = engineAvailable() ? httpPagesPort() : null;

export const checks: Check[] = port ? linkScriptChecks(port) : [];
