import type { WindowsNative } from "@ardia/shell";
import { engineAvailable, hostCall, onEngineTopic } from "../engine/host";
import { requireNativeModule } from "../modules";
import { httpPagesPort } from "./engineBackForward";
import type { ListedTab, TabEvent } from "./engineHost";
import { expectEqual, expectTrue, type Check } from "./check";

const VISIBLE = 4;
const RECENTLY_VISIBLE = 7;
const DEVTOOLS_OPEN = 24;
const INSPECTED_BY_ANOTHER_CLIENT = 105;
const FORM_INTERACTIONS = 26;
const USER_EDITS = 27;
const TITLE = "sleep page";
export const LINKS_TITLE = "links page";
const OPENS_LIVE_PAGE = 100;
const EVENT_MS = 8000;
const POPUP_NAME = "ardia-sleep-check-popup";
const LOAD_MS = 20000;
const DEVTOOLS_GONE_MS = 3000;
const POLL_MS = 100;
const EVALUATE_MS = 5000;
const SCROLLED_TO = 3000;
const SCROLL_SAVED_MS = 1500;
export const LEFT = { unit: "px", x: 0, y: 40, width: 300, height: 240 };
export const RIGHT = { unit: "px", x: 310, y: 40, width: 300, height: 240 };

type Listed = Pick<ListedTab, "key" | "title"> & { loading?: boolean; discarded?: boolean; url?: string };

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const firstWindow = async () => {
  const ids = await requireNativeModule<Pick<WindowsNative, "windowIds">>("ArdiaAppWindows").windowIds();
  expectTrue(ids.length > 0, "no window is open to host a page");
  return ids[0]!;
};

const popupPages = async () => ((await hostCall<{ tabs?: Listed[] }>("tabs.list")).tabs ?? []).map((tab) => String(tab.key)).filter((key) => key.startsWith("popup:"));

export const listed = async (key: string) => (await hostCall<{ tabs?: Listed[] }>("tabs.list")).tabs?.find((tab) => tab.key === key);

export async function until<T>(what: string, ms: number, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const by = Date.now() + ms;
  let value = await read();
  while (!done(value)) {
    if (Date.now() > by) throw new Error(`${what} within ${ms} ms: last ${JSON.stringify(value)}`);
    await pause(POLL_MS);
    value = await read();
  }
  return value;
}

export const painted = (key: string) => until(`the page ${key} has its first contentful paint`, LOAD_MS, async () => evaluate(key, 'post("result", JSON.stringify(performance.getEntriesByName("first-contentful-paint").length));'), (count) => Number(count) > 0);

const CALL_MS = 15000;

export async function timedCall<Result = unknown>(verb: string, args: Record<string, unknown> = {}, windowId = ""): Promise<Result> {
  const what = `${verb} ${String(args.key ?? "")}`.trim();
  console.info(`[ardia windows] self-check step: ${what}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} gave no answer within ${CALL_MS} ms`)), CALL_MS);
  });
  try {
    return await Promise.race([hostCall<Result>(verb, args, windowId), late]);
  } finally {
    clearTimeout(timer);
  }
}

export const loaded = (key: string, title = TITLE) => until(`the page ${key} loads`, LOAD_MS, () => listed(key), (tab) => tab?.title === title && tab.loading === false && tab.discarded !== true);

function withDeadline<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} gave no answer within ${EVALUATE_MS} ms`)), EVALUATE_MS);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export const evaluate = async (key: string, code: string, userGesture = false) => {
  const reply = await withDeadline(hostCall<{ result?: unknown }>("tab.call", { key, method: "evaluate", code, userGesture }), `the page ${key}`);
  return typeof reply.result === "string" ? (JSON.parse(reply.result) as unknown) : null;
};

export const keptBy = (key: string, seconds: number) =>
  until(
    `the page ${key} is asked to sleep with no DevTools session left from the check's own calls`,
    DEVTOOLS_GONE_MS,
    async () => (await hostCall<{ keptBy?: unknown }>("tab.call", { key, method: "sleepIfHidden", seconds })).keptBy,
    (kept) => !(Array.isArray(kept) && kept.length === 1 && kept[0] === DEVTOOLS_OPEN),
  );

type HeardEvent = Omit<TabEvent, "data"> & { data?: Record<string, unknown>; opener?: unknown; url?: unknown; fromClick?: unknown };

export function heard(topic: string, wanted: (event: HeardEvent) => boolean, what: string): Promise<HeardEvent> {
  return new Promise((resolve, reject) => {
    const watching = onEngineTopic(topic, (event: HeardEvent) => {
      if (!wanted(event)) return;
      clearTimeout(deadline);
      watching.remove();
      resolve(event);
    });
    const deadline = setTimeout(() => {
      watching.remove();
      reject(new Error(`${what}: nothing within ${EVENT_MS} ms`));
    }, EVENT_MS);
  });
}

export const click = (key: string, x: number, y: number, modifiers = 0) => hostCall("tab.call", { key, method: "clickForTest", x, y, modifiers });

export async function sleepOnce(key: string, windowId: string, title: string) {
  await hide(key, windowId);
  expectEqual(await keptBy(key, 0), [], "the hidden page sleeps");
  expectEqual((await listed(key))?.discarded, true, "the page is discarded");
  await show(key, windowId, LEFT);
  await loaded(key, title);
}

export async function withPages(names: string[], run: (keys: string[], windowId: string) => Promise<void>, path = "sleep", title = TITLE) {
  const port = httpPagesPort();
  expectTrue(port, "the launch has no loopback page server (test httpPages)");
  const windowId = await firstWindow();
  const keys = names.map((name) => `self-check-sleep-${name}`);
  try {
    for (const [index, key] of keys.entries()) await hostCall("tab.create", { key, url: `http://127.0.0.1:${port}/${path}?${names[index]}`, profile: "" }, windowId);
    for (const key of keys) await loaded(key, title);
    await run(keys, windowId);
  } finally {
    for (const key of keys) await hostCall("tab.close", { key }).catch(() => null);
  }
}

export const show = (key: string, windowId: string, place: object) => hostCall("tab.show", { key, visible: true, ...place }, windowId);
export const hide = (key: string, windowId: string) => hostCall("tab.show", { key, visible: false }, windowId);

const sleepChecks: Check[] = [
  {
    name: "engine sleep: a shown page and the second pane of a split, shown beside it, are kept awake as visible",
    run: () =>
      withPages(["shown", "pane"], async ([shown, pane], windowId) => {
        await show(shown!, windowId, LEFT);
        await show(pane!, windowId, RIGHT);
        const kept = { shown: await keptBy(shown!, 0), pane: await keptBy(pane!, 0) };
        expectTrue(Array.isArray(kept.shown) && kept.shown.includes(VISIBLE) && Array.isArray(kept.pane) && kept.pane.includes(VISIBLE), `both kept as visible (${VISIBLE}): ${JSON.stringify(kept)}`);
        expectEqual([(await listed(shown!))?.discarded, (await listed(pane!))?.discarded], [false, false], "both pages still loaded");
      }),
  },
  {
    name: "engine sleep: a page hidden moments ago is kept as recently visible while the app's hidden time hasn't passed",
    run: () =>
      withPages(["recent"], async ([recent], windowId) => {
        await show(recent!, windowId, LEFT);
        await hide(recent!, windowId);
        const kept = await keptBy(recent!, 3600);
        expectTrue(Array.isArray(kept) && kept.includes(RECENTLY_VISIBLE), `kept as recently visible (${RECENTLY_VISIBLE}): ${JSON.stringify(kept)}`);
        expectEqual((await listed(recent!))?.discarded, false, "the page still loaded");
      }),
  },
  {
    name: "engine sleep: a hidden page with text typed into a form is kept, so the typing isn't lost",
    run: () =>
      withPages(["form"], async ([form], windowId) => {
        await show(form!, windowId, LEFT);
        await evaluate(form!, `document.getElementById("field").focus(); post("result", "null");`);
        await hostCall("tab.call", { key: form!, method: "insertText", text: "typed by the self-check" });
        expectEqual(await evaluate(form!, `post("result", JSON.stringify(document.getElementById("field").value));`), "typed by the self-check", "the field's text");
        await hide(form!, windowId);
        const kept = await keptBy(form!, 0);
        expectTrue(Array.isArray(kept) && (kept.includes(FORM_INTERACTIONS) || kept.includes(USER_EDITS)), `kept for its form (${FORM_INTERACTIONS} or ${USER_EDITS}): ${JSON.stringify(kept)}`);
        expectEqual((await listed(form!))?.discarded, false, "the page still loaded");
      }),
  },
  {
    name: "engine sleep: a hidden quiet page sleeps when asked, and wakes on show at the same address and scroll",
    run: () =>
      withPages(["quiet"], async ([quiet], windowId) => {
        await show(quiet!, windowId, LEFT);
        const scrolled = await evaluate(quiet!, `window.scrollTo(0, ${SCROLLED_TO}); setTimeout(() => post("result", JSON.stringify(Math.round(window.scrollY))), 50);`);
        expectEqual(scrolled, SCROLLED_TO, "the page's scroll before it sleeps");
        await pause(SCROLL_SAVED_MS);
        const address = (await listed(quiet!))?.url;
        await hide(quiet!, windowId);
        expectEqual(await keptBy(quiet!, 0), [], "nothing keeps a hidden quiet page awake once the hidden time has passed");
        expectEqual((await listed(quiet!))?.discarded, true, "the page is discarded");
        await show(quiet!, windowId, LEFT);
        const woke = await loaded(quiet!);
        expectEqual(woke?.url, address, "the address after it wakes");
        const back = await until("the scroll comes back", LOAD_MS, () => evaluate(quiet!, `post("result", JSON.stringify(Math.round(window.scrollY)));`), (y) => y === SCROLLED_TO);
        expectEqual(back, SCROLLED_TO, "the scroll after it wakes");
      }),
  },
  {
    name: "engine sleep: a hidden page whose DevTools window is open is kept, and sleeps once that window is closed",
    run: () =>
      withPages(["devtools"], async ([page], windowId) => {
        await show(page!, windowId, LEFT);
        await hide(page!, windowId);
        await hostCall("tab.call", { key: page!, method: "showDevTools" });
        let open = true;
        try {
          const kept = await hostCall<{ keptBy?: unknown }>("tab.call", { key: page!, method: "sleepIfHidden", seconds: 0 });
          expectTrue(Array.isArray(kept.keptBy) && kept.keptBy.includes(INSPECTED_BY_ANOTHER_CLIENT), `kept while its DevTools window is open (${INSPECTED_BY_ANOTHER_CLIENT}): ${JSON.stringify(kept.keptBy)}`);
          await hostCall("tab.call", { key: page!, method: "showDevTools", panel: "toggle" });
          open = false;
          const after = await until(
            "the page sleeps once its DevTools window is closed",
            DEVTOOLS_GONE_MS,
            async () => (await hostCall<{ keptBy?: unknown }>("tab.call", { key: page!, method: "sleepIfHidden", seconds: 0 })).keptBy,
            (keptBy) => Array.isArray(keptBy) && keptBy.length === 0,
          );
          expectEqual(after, [], "nothing keeps it once the window is closed");
        } finally {
          if (open) await hostCall("tab.call", { key: page!, method: "showDevTools", panel: "toggle" }).catch(() => null);
        }
      }),
  },
  {
    name: "engine sleep: a tab that slept once still opens a new tab its link script saw clicked (the script Peek runs in) and an app-link ask",
    run: () =>
      withPages(
        ["links"],
        async ([page], windowId) => {
          await show(page!, windowId, LEFT);
          await sleepOnce(page!, windowId, LINKS_TITLE);
          await painted(page!);
          const opened = heard("tab.opened", (event) => event.opener === page, "a new tab from a target=_blank click");
          await click(page!, 110, 90);
          const tab = await opened;
          expectTrue(String(tab.url).endsWith("/b"), "the new tab opens the link's address");
          expectEqual(tab.fromClick, true, "the woken page's link script saw the click (fromClick)");
          const ask = heard("tab", (event) => event.key === page && event.name === "externalApp", "an app-link ask from a click");
          await click(page!, 110, 150);
          expectEqual((await ask).data?.url, "ardia-sleep-check-link:woke", "the app-link ask");
        },
        "links",
        LINKS_TITLE,
      ),
  },
  {
    name: "engine sleep: the opener of a live pop-up is kept, so the pop-up's window.opener still works, and sleeps once the pop-up is closed",
    run: () =>
      withPages(["opener"], async ([page], windowId) => {
        await show(page!, windowId, LEFT);
        const popupsBefore = await popupPages();
        const opened = heard("tab.opened", (event) => event.opener === page, "the pop-up");
        expectEqual(await evaluate(page!, `post("result", JSON.stringify(!!window.open("about:blank", "${POPUP_NAME}", "width=320,height=240")));`, true), true, "window.open with a click returns a window");
        await opened;
        await until("the pop-up is adopted into its window", LOAD_MS, () => popupPages(), (keys) => keys.some((key) => !popupsBefore.includes(key)));
        await hide(page!, windowId);
        try {
          const kept = await keptBy(page!, 0);
          expectTrue(Array.isArray(kept) && kept.includes(OPENS_LIVE_PAGE), `kept as the opener of a live pop-up (${OPENS_LIVE_PAGE}): ${JSON.stringify(kept)}`);
          expectEqual(await evaluate(page!, `const w = window.open("", "${POPUP_NAME}"); post("result", JSON.stringify(!!w && w.opener === window));`), true, "the pop-up's opener is still this page");
        } finally {
          await evaluate(page!, `const w = window.open("", "${POPUP_NAME}"); if (w) w.close(); post("result", "null");`).catch(() => null);
        }
        const after = await until(
          "the opener sleeps once its pop-up is closed",
          LOAD_MS,
          async () => (await hostCall<{ keptBy?: unknown }>("tab.call", { key: page!, method: "sleepIfHidden", seconds: 0 })).keptBy,
          (kept) => Array.isArray(kept) && kept.length === 0,
        );
        expectEqual(after, [], "nothing keeps it once the pop-up is closed");
      }),
  },
];

export const checks: Check[] = engineAvailable() ? sleepChecks : [];
