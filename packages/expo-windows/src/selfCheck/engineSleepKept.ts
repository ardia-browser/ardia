import { engineAvailable, hostCall, leaveOffersFromUnheard } from "../engine/host";
import { mountPage } from "../engine/pages";
import { setPopupsOpenAsTabs } from "../engine/popupsAsTabs";
import { expectEqual, expectTrue, type Check } from "./check";
import { httpPagesPort } from "./engineBackForward";
import { click, evaluate, firstWindow, hide, keptBy, LEFT, listed, loaded, RIGHT, show, until, withPages } from "./engineSleep";

const OPENS_LIVE_PAGE = 100;
const UNSAVED_AFTER_USE = 101;
const HOLDS_WEB_LOCK = 102;
const HOLDS_BLOCKING_INDEXEDDB_LOCK = 103;
const LIVE_CONNECTION = 104;
const INSPECTED_BY_ANOTHER_CLIENT = 105;
const SIGNAL_MS = 5000;
const UNHEARD_POPUP = "ardia-sleep-check-unheard";
const TAB_POPUP = "ardia-sleep-check-as-tab";
const OFFER_MS = 8000;

const DISCARD_REASONS = ["proactive", "urgent", "frozen"] as const;

type Eligibility = { result?: unknown; reasons?: unknown; keptBy?: unknown };

const eligibility = (key: string, reason: (typeof DISCARD_REASONS)[number], withoutHost = false) =>
  hostCall<Eligibility>("tab.call", { key, method: "discardEligibilityForTest", reason, withoutHost });

async function keptWithin(key: string, code: number, what: string) {
  await until(what, SIGNAL_MS, () => eligibility(key, "proactive"), (answer) => Array.isArray(answer.keptBy) && answer.keptBy.includes(code));
  for (const reason of DISCARD_REASONS) {
    const asked = await eligibility(key, reason);
    expectEqual(asked.result, "protected", `Chromium's own ${reason} discard asks the host and is refused (${JSON.stringify(asked)})`);
    await until(`without the host's answer, Chromium's own ${reason} discard would take the page`, SIGNAL_MS, () => eligibility(key, reason, true), (answer) => answer.result === "eligible");
  }
  const kept = await keptBy(key, 0);
  expectTrue(Array.isArray(kept) && kept.includes(code), `sleepIfHidden keeps it too (${code}): ${JSON.stringify(kept)}`);
}

const sleepsWithin = (key: string, what: string) => until(what, SIGNAL_MS, () => keptBy(key, 0), (kept) => Array.isArray(kept) && kept.length === 0);

const BEFORE_UNLOAD = `addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = ""; }); post("result", "null");`;

const keptChecks: Check[] = [
  {
    name: "engine sleep: an ordinary hidden page is eligible for Chromium's own proactive, urgent and frozen-growth discards",
    run: () =>
      withPages(["plain"], async ([page], windowId) => {
        await show(page!, windowId, LEFT);
        await hide(page!, windowId);
        for (const reason of DISCARD_REASONS) {
          await until(`an ordinary hidden page is eligible for a ${reason} discard`, SIGNAL_MS, () => eligibility(page!, reason), (answer) => answer.result === "eligible");
        }
      }),
  },
  {
    name: "engine sleep: a hidden page with a beforeunload handler the user has used is kept; the same page nobody used sleeps",
    run: () =>
      withPages(["unsaved", "untouched"], async ([unsaved, untouched], windowId) => {
        await show(unsaved!, windowId, LEFT);
        await show(untouched!, windowId, RIGHT);
        await evaluate(unsaved!, BEFORE_UNLOAD);
        await evaluate(untouched!, BEFORE_UNLOAD);
        await click(unsaved!, 150, 160);
        await hide(unsaved!, windowId);
        await hide(untouched!, windowId);
        await keptWithin(unsaved!, UNSAVED_AFTER_USE, `the used page is kept for its beforeunload (${UNSAVED_AFTER_USE})`);
        expectEqual(await sleepsWithin(untouched!, "the page nobody used sleeps despite its beforeunload"), [], "the untouched page");
        expectEqual((await listed(unsaved!))?.discarded, false, "the used page is still loaded");
      }),
  },
  {
    name: "engine sleep: a hidden page holding a Web Lock is kept",
    run: () =>
      withPages(["lock"], async ([page], windowId) => {
        await show(page!, windowId, LEFT);
        await evaluate(page!, `navigator.locks.request("ardia-sleep-check", () => new Promise(() => {})); post("result", "null");`);
        await hide(page!, windowId);
        await keptWithin(page!, HOLDS_WEB_LOCK, `kept while it holds a Web Lock (${HOLDS_WEB_LOCK})`);
      }),
  },
  {
    name: "engine sleep: a hidden page whose open IndexedDB connection blocks another page's upgrade is kept",
    run: () =>
      withPages(["idb-holder", "idb-waiter"], async ([holder, waiter], windowId) => {
        await show(holder!, windowId, LEFT);
        await show(waiter!, windowId, RIGHT);
        const opened = await evaluate(
          holder!,
          `const open = indexedDB.open("ardia-sleep-check", 1); open.onupgradeneeded = () => open.result.createObjectStore("kept"); open.onsuccess = () => { window.ardiaDatabase = open.result; post("result", JSON.stringify("open")); }; open.onerror = () => post("result", JSON.stringify("error"));`,
        );
        expectEqual(opened, "open", "the holder's IndexedDB connection");
        const upgrade = await evaluate(
          waiter!,
          `const open = indexedDB.open("ardia-sleep-check", 2); window.ardiaUpgrade = open; open.onblocked = () => post("result", JSON.stringify("blocked")); open.onsuccess = () => post("result", JSON.stringify("opened")); open.onerror = () => post("result", JSON.stringify("error"));`,
        );
        expectEqual(upgrade, "blocked", "the other page's upgrade waits on the holder's connection");
        await hide(holder!, windowId);
        await keptWithin(holder!, HOLDS_BLOCKING_INDEXEDDB_LOCK, `kept while its connection blocks another page (${HOLDS_BLOCKING_INDEXEDDB_LOCK})`);
      }),
  },
  {
    name: "engine sleep: a hidden page with an open WebSocket is kept as in use",
    run: () =>
      withPages(["socket"], async ([page], windowId) => {
        await show(page!, windowId, LEFT);
        const opened = await evaluate(
          page!,
          `const ws = new WebSocket("ws://" + location.host + "/ws"); window.ardiaSocket = ws; ws.onopen = () => post("result", JSON.stringify("open")); ws.onerror = () => post("result", JSON.stringify("error"));`,
        );
        expectEqual(opened, "open", "the WebSocket to the loopback server");
        await hide(page!, windowId);
        await keptWithin(page!, LIVE_CONNECTION, `kept while its WebSocket is open (${LIVE_CONNECTION})`);
      }),
  },
  {
    name: "engine sleep: a hidden page another DevTools client is attached to is kept, and sleeps once that client detaches",
    run: () =>
      withPages(["client"], async ([page], windowId) => {
        await show(page!, windowId, LEFT);
        await hide(page!, windowId);
        await hostCall("tab.call", { key: page!, method: "testClient", attach: true });
        let attached = true;
        try {
          await keptWithin(page!, INSPECTED_BY_ANOTHER_CLIENT, `kept while another DevTools client is attached (${INSPECTED_BY_ANOTHER_CLIENT})`);
          await hostCall("tab.call", { key: page!, method: "testClient", attach: false });
          attached = false;
          expectEqual(await sleepsWithin(page!, "the page sleeps once the client detaches"), [], "after the client detached");
        } finally {
          if (attached) await hostCall("tab.call", { key: page!, method: "testClient", attach: false }).catch(() => null);
        }
      }),
  },
  {
    name: "engine sleep: the opener of a pop-up still waiting as an offer the app hasn't taken is kept",
    run: () =>
      withPages(["offer"], async ([page], windowId) => {
        await show(page!, windowId, LEFT);
        leaveOffersFromUnheard(page!);
        try {
          expectEqual(await evaluate(page!, `post("result", JSON.stringify(!!window.open("about:blank", "${UNHEARD_POPUP}", "width=320,height=240")));`, true), true, "window.open returns a window");
          await hide(page!, windowId);
          await keptWithin(page!, OPENS_LIVE_PAGE, `kept as the opener of a pending offer (${OPENS_LIVE_PAGE})`);
        } finally {
          leaveOffersFromUnheard(null);
          await evaluate(page!, `const w = window.open("", "${UNHEARD_POPUP}"); if (w) w.close(); post("result", "null");`).catch(() => null);
        }
      }),
  },
  {
    name: "engine sleep: the opener of a pop-up opened as a tab (Open pop-up windows as tabs) is kept",
    async run() {
      const port = httpPagesPort();
      expectEqual(typeof port, "string", "the launch's loopback page server");
      const windowId = await firstWindow();
      const opener = "self-check-sleep-astab";
      const tab = "self-check-sleep-astab-tab";
      const offered: string[] = [];
      const closeOpener = mountPage(opener, { url: `http://127.0.0.1:${port}/sleep?astab`, profile: "", windowId }, (name, data) => {
        const adopt = (data as { adoptId?: unknown } | null)?.adoptId;
        if (name === "openWindow" && typeof adopt === "string") offered.push(adopt);
      });
      let closeTab: (() => void) | null = null;
      setPopupsOpenAsTabs(true);
      try {
        await loaded(opener);
        await show(opener, windowId, LEFT);
        expectEqual(await evaluate(opener, `post("result", JSON.stringify(!!window.open("about:blank", "${TAB_POPUP}", "width=320,height=240")));`, true), true, "window.open with a click returns a window");
        await until("the pop-up is offered to the opener's page as a tab", OFFER_MS, async () => offered.length, (count) => count > 0);
        closeTab = mountPage(tab, { url: "", profile: "", adopt: offered[0], windowId }, () => {});
        await until("the pop-up is adopted as a tab", OFFER_MS, () => listed(tab), (listedTab) => !!listedTab);
        await hide(opener, windowId);
        await keptWithin(opener, OPENS_LIVE_PAGE, `kept as the opener of a pop-up opened as a tab (${OPENS_LIVE_PAGE})`);
      } finally {
        setPopupsOpenAsTabs(false);
        closeTab?.();
        closeOpener();
      }
    },
  },
];

export const checks: Check[] = engineAvailable() ? keptChecks : [];
