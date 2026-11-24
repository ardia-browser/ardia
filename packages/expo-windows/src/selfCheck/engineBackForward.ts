import type { AppNative, WindowsNative } from "@ardia/shell";
import { engineAvailable, hostCall, onEngineTopic } from "../engine/host";
import { requireNativeModule } from "../modules";
import { expectEqual, expectTrue, type Check } from "./check";
import type { ListedTab as HostListedTab } from "./engineHost";

const CACHE_KEY = "self-check-cached-page";
const LOAD_MS = 20000;
const CACHED_MS = 3000;
const ASK_ATTEMPTS = 4;

type ListedTab = Pick<HostListedTab, "key" | "title">;

export const httpPagesPort = () => {
  const port = requireNativeModule<Pick<AppNative, "launchConfig">>("ArdiaApp").launchConfig().test?.httpPages;
  return typeof port === "string" && /^\d+$/.test(port) ? port : null;
};

const titleOf = async () => (await hostCall<{ tabs: ListedTab[] }>("tabs.list")).tabs.find((tab) => tab.key === CACHE_KEY)?.title;

const titleWithin = async (wanted: string, ms: number) => {
  const by = Date.now() + ms;
  let title = await titleOf();
  while (title !== wanted && Date.now() < by) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    title = await titleOf();
  }
  return title;
};

const titled = async (titles: string[]) => {
  const by = Date.now() + LOAD_MS;
  let title = await titleOf();
  while (!titles.includes(title ?? "") && Date.now() < by) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    title = await titleOf();
  }
  expectTrue(titles.includes(title ?? ""), `the cached page's tab is titled ${JSON.stringify(title)}, not one of ${JSON.stringify(titles)}`);
  return title!;
};

const evaluate = async (code: string) => (await hostCall<{ result?: unknown }>("tab.call", { key: CACHE_KEY, method: "evaluate", code, userGesture: true })).result;

const FLOOD_GUARD_REARM_URL = "hcp:ardia-self-check";
const PLACE = { unit: "px", x: 40, y: 60, width: 320, height: 240 };

const askOnce = (link: string, waitMs: number) => {
  const asked = new Promise<Record<string, unknown> | null>((resolve) => {
    const watching = onEngineTopic("tab", (event: { key?: unknown; name?: unknown; data?: unknown }) => {
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (event.key !== CACHE_KEY || event.name !== "externalApp" || data.url !== link) return;
      clearTimeout(deadline);
      watching.remove();
      resolve(data);
    });
    const deadline = setTimeout(() => {
      watching.remove();
      resolve(null);
    }, waitMs);
  });
  return hostCall("tab.call", { key: CACHE_KEY, method: "executeJavaScript", code: `location.href = ${JSON.stringify(link)}` }).then(() => asked);
};

const ask = async (link: string) => {
  let data = await askOnce(link, 3000);
  for (let attempt = 0; attempt < ASK_ATTEMPTS && !data; attempt++) {
    await hostCall("tab.call", { key: CACHE_KEY, method: "loadUrl", url: FLOOD_GUARD_REARM_URL, userInitiated: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    data = await askOnce(link, 3000);
  }
  if (!data) throw new Error(`no externalApp event for ${link} after ${ASK_ATTEMPTS + 1} tries (the page is titled ${JSON.stringify(await titleOf())})`);
  return data.id;
};

const alive = async (id: unknown) => (await hostCall<{ alive?: unknown }>("tab.call", { key: CACHE_KEY, method: "externalAppAlive", id })).alive;

const notRestoredReasons = () =>
  evaluate(`post("result", JSON.stringify(performance.getEntriesByType("navigation")[0]?.notRestoredReasons ?? null));`).then(
    (reasons) => String(reasons),
    (error: unknown) => `unknown (${String(error)})`,
  );

const firstWindow = async () => {
  const ids = await requireNativeModule<Pick<WindowsNative, "windowIds">>("ArdiaAppWindows").windowIds();
  expectTrue(ids.length > 0, "no window is open to host a page");
  return ids[0]!;
};

const backForwardChecks = (port: string): Check[] => [
  {
    name: "engine: an http page's ask to open another app doesn't count while the page waits in the back/forward cache, and counts again once Back shows that page",
    async run() {
      const origin = `http://127.0.0.1:${port}`;
      const windowId = await firstWindow();
      await hostCall("tab.create", { key: CACHE_KEY, url: `${origin}/a`, profile: "" }, windowId);
      try {
        await hostCall("tab.show", { key: CACHE_KEY, visible: true, ...PLACE }, windowId);
        await titled(["loaded a"]);
        const cachedAsk = await ask("ardia-self-check-link:cached");
        await hostCall("tab.call", { key: CACHE_KEY, method: "loadUrl", url: `${origin}/b` });
        await titled(["loaded b"]);
        await new Promise((resolve) => setTimeout(resolve, CACHED_MS));
        const whileCached = await alive(cachedAsk);
        await hostCall("tab.call", { key: CACHE_KEY, method: "goBack" });
        const back = await titleWithin("restored a", LOAD_MS);
        const reasons = back === "restored a" ? "" : `${JSON.stringify(back)}, notRestoredReasons ${await notRestoredReasons()}`;
        const oldAskAfterBack = await alive(cachedAsk);
        const freshAsk = await alive(await ask("ardia-self-check-link:after-back"));
        expectEqual(
          { restoredFromTheCache: back === "restored a", whileCached, oldAskAfterBack, freshAsk },
          { restoredFromTheCache: true, whileCached: false, oldAskAfterBack: true, freshAsk: true },
          `externalAppAlive around the back/forward cache${reasons ? `; the page wasn't restored from the cache: titled ${reasons}` : ""}`,
        );
      } finally {
        await hostCall("tab.close", { key: CACHE_KEY });
      }
    },
  },
];

const port = engineAvailable() ? httpPagesPort() : null;

export const checks: Check[] = port ? backForwardChecks(port) : [];
