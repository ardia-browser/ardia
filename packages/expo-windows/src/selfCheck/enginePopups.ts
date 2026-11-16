import { hostCall, leaveOffersFromUnheard, onEngineTopic } from "../engine/host";
import { showStepsOf, traceShowsOf } from "../engine/showTrace";
import type { WindowsNative } from "@ardia/shell";
import { isPopupWindowId } from "@ardia/shell/src/windows.ts";
import { requireNativeModule } from "../modules";
import { expectEqual, expectTrue, type Check } from "./check";

const POPUP_WINDOW_GONE_MS = 3000;
const popupWindows = async () => (await requireNativeModule<Pick<WindowsNative, "windowIds">>("ArdiaAppWindows").windowIds()).filter((id) => isPopupWindowId(id));

async function popupWindowsGone(before: readonly string[], withinMs: number) {
  const began = Date.now();
  while (Date.now() - began < withinMs) {
    if ((await popupWindows()).every((id) => before.includes(id))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export const pagePopupCheck = (pageKey: string, firstWindow: () => Promise<string>): Check => ({
  name: "engine: a pop-up a page opens with a click waits in the background of its window, sent to the app as a pop-up with the size it asked for and its opener, the opener stays the shown tab, and no Chromium pop-up window opens",
  async run() {
    const windowId = await firstWindow();
    await hostCall("tab.show", { key: pageKey, visible: true, unit: "px", x: 40, y: 60, width: 300, height: 240 }, windowId);
    const popupName = "ardia-self-check-popup";
    const opened = new Promise<Record<string, unknown>>((resolve, reject) => {
      const watching = onEngineTopic("tab.opened", (event: Record<string, unknown>) => {
        if (event.opener !== pageKey) return;
        clearTimeout(deadline);
        watching.remove();
        resolve(event);
      });
      const deadline = setTimeout(() => {
        watching.remove();
        reject(new Error("no tab.opened from the page's pop-up within 10000 ms"));
      }, 10000);
    });
    const evaluate = async (code: string, userGesture = false) => {
      const reply = await hostCall<{ result?: unknown }>("tab.call", { key: pageKey, method: "evaluate", userGesture, code });
      return typeof reply.result === "string" ? (JSON.parse(reply.result) as unknown) : null;
    };
    const popupsBefore = await popupWindows();
    try {
      const before = await evaluate(`window.ardiaHiddenSeen = false; document.addEventListener("visibilitychange", () => { if (document.visibilityState !== "visible") window.ardiaHiddenSeen = true; }); post("result", JSON.stringify(document.visibilityState));`);
      expectEqual(before, "visible", "the opener page before its pop-up opens");
      const asked = await evaluate(`post("result", JSON.stringify(!!window.open("about:blank", "${popupName}", "width=420,height=360,left=600,top=400")));`, true);
      expectEqual(asked, true, "window.open with a click returns a window");
      const event = await opened;
      const popup = (event.popup ?? null) as Record<string, unknown> | null;
      expectEqual(
        { window: event.window, profile: event.profile, width: popup?.width, height: popup?.height, placed: typeof popup?.x === "number" && typeof popup?.y === "number" },
        { window: true, profile: "", width: 420, height: 360, placed: true },
        "the pop-up's tab.opened",
      );
      expectEqual((await hostCall<{ popupBrowsers?: unknown }>("host.info")).popupBrowsers, 0, "Chromium pop-up windows");
      type Listed = { key?: unknown; shown?: unknown; windowVisible?: unknown; width?: unknown; height?: unknown };
      const inPopupWindow = async () => (await hostCall<{ tabs?: Listed[] }>("tabs.list")).tabs?.find((tab) => typeof tab.key === "string" && tab.key.startsWith("popup:"));
      const by = Date.now() + 8000;
      let listed = await inPopupWindow();
      while (!(listed?.shown === true && listed.windowVisible === true) && Date.now() < by) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        listed = await inPopupWindow();
      }
      expectEqual({ shown: listed?.shown, windowVisible: listed?.windowVisible }, { shown: true, windowVisible: true }, `the pop-up's page in the app's pop-up window (listed: ${JSON.stringify(listed ?? null)})`);
      const linked = await evaluate(
        `const w = window.open("", "${popupName}"); const linked = !!w && w.opener === window; if (w) w.close(); setTimeout(() => post("result", JSON.stringify({ linked, closed: !!w && w.closed })), 1500);`,
      );
      expectEqual(
        await evaluate(`post("result", JSON.stringify({ hiddenSeen: window.ardiaHiddenSeen === true, now: document.visibilityState }));`),
        { hiddenSeen: false, now: "visible" },
        "the opener page stays the visible tab of its window while its pop-up waits for the app and after",
      );
      expectEqual(linked, { linked: true, closed: true }, "the pop-up's opener, and window.close() from its opener");
      expectTrue(await popupWindowsGone(popupsBefore, POPUP_WINDOW_GONE_MS), `the app's pop-up window was still open ${POPUP_WINDOW_GONE_MS} ms after its page was closed by window.close(): ${JSON.stringify(await popupWindows())}`);
    } finally {
      await evaluate(`const w = window.open("", "${popupName}"); if (w) w.close(); post("result", "null");`).catch(() => null);
      await hostCall("tab.show", { key: pageKey, visible: false }, windowId).catch(() => null);
    }
  },
});

type ListedTab = { key?: unknown; shown?: unknown; windowVisible?: unknown };
const LOOP_ROUNDS = 20;
const SHOW_MS = 4000;
const GONE_MS = 3000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const listedTabs = async () => (await hostCall<{ tabs?: ListedTab[] }>("tabs.list")).tabs ?? [];
const popupTabs = async () => (await listedTabs()).filter((tab): tab is ListedTab & { key: string } => typeof tab.key === "string" && tab.key.startsWith("popup:"));

async function evaluateIn(pageKey: string, code: string, userGesture = false) {
  const reply = await hostCall<{ result?: unknown }>("tab.call", { key: pageKey, method: "evaluate", userGesture, code });
  return typeof reply.result === "string" ? (JSON.parse(reply.result) as unknown) : null;
}

async function newPopupTab(seen: Set<string>, by: number) {
  for (;;) {
    const tab = (await popupTabs()).find((listed) => !seen.has(listed.key));
    if (tab && ((tab.shown === true && tab.windowVisible === true) || Date.now() >= by)) return tab;
    if (!tab && Date.now() >= by) return null;
    await pause(100);
  }
}

export const pagePopupShowLoop = (pageKey: string): Check => ({
  name: `engine: a page's pop-up shows its page in the app's pop-up window, ${LOOP_ROUNDS} times in a row`,
  async run() {
    const seen = new Set((await popupTabs()).map((tab) => tab.key));
    const failures: string[] = [];
    traceShowsOf((key) => key.startsWith("popup:"));
    try {
      for (let round = 0; round < LOOP_ROUNDS; round++) {
        const name = `ardia-self-check-loop-${round}`;
        await evaluateIn(pageKey, `post("result", JSON.stringify(!!window.open("about:blank", "${name}", "width=360,height=280,left=220,top=160")));`, true);
        const tab = await newPopupTab(seen, Date.now() + SHOW_MS);
        if (!tab) failures.push(`round ${round}: no pop-up tab within ${SHOW_MS} ms`);
        else if (tab.shown !== true || tab.windowVisible !== true) failures.push(`round ${round}: ${tab.key} ${JSON.stringify(tab)}; steps: ${showStepsOf(tab.key).join(" | ")}`);
        if (tab) seen.add(tab.key);
        await evaluateIn(pageKey, `const w = window.open("", "${name}"); if (w) w.close(); post("result", "null");`);
        const goneBy = Date.now() + GONE_MS;
        while (tab && (await popupTabs()).some((listed) => listed.key === tab.key) && Date.now() < goneBy) await pause(100);
      }
    } finally {
      traceShowsOf(null);
    }
    expectEqual(failures, [], `pop-ups whose page never showed in ${LOOP_ROUNDS} rounds`);
  },
});

const UNHEARD_OFFER_WAIT_MS = 9000;

export const unheardOfferCheck = (pageKey: string): Check => ({
  name: "engine: a tab a page opens that the app never hears of is closed after the deadline, while its opener's window stays",
  async run() {
    const name = "ardia-self-check-unheard";
    leaveOffersFromUnheard(pageKey);
    try {
      expectEqual(await evaluateIn(pageKey, `post("result", JSON.stringify(!!window.open("about:blank", "${name}", "width=320,height=240")));`, true), true, "window.open with a click returns a window");
      await pause(1000);
      expectEqual(await evaluateIn(pageKey, `const w = window.open("", "${name}"); post("result", JSON.stringify(!!w && !w.closed));`), true, "the unheard pop-up is still open a second later");
      await pause(UNHEARD_OFFER_WAIT_MS);
      expectEqual(
        await evaluateIn(pageKey, `const w = window.open("", "${name}"); post("result", JSON.stringify(!!w && !w.closed));`),
        false,
        `the unheard pop-up ${UNHEARD_OFFER_WAIT_MS + 1000} ms after it opened`,
      );
      expectEqual((await listedTabs()).some((tab) => tab.key === pageKey), true, "the opener page is still open");
    } finally {
      leaveOffersFromUnheard(null);
      await evaluateIn(pageKey, `const w = window.open("", "${name}"); if (w) w.close(); post("result", "null");`).catch(() => null);
    }
  },
});

export const popupChecks = (pageKey: string, firstWindow: () => Promise<string>): Check[] => [pagePopupCheck(pageKey, firstWindow), pagePopupShowLoop(pageKey), unheardOfferCheck(pageKey)];
