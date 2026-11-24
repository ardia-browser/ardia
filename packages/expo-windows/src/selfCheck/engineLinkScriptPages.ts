import { engineAvailable, hostCall, onEngineTopic } from "../engine/host";
import { httpPagesPort } from "./engineBackForward";
import { expectEqual, expectTrue, type Check } from "./check";
import { click, evaluate, heard, LEFT, LINKS_TITLE, listed, painted, pause, show, until, withPages } from "./engineSleep";

const LOAD_MS = 20000;
const BLANK_LINK = { x: 110, y: 90 };
const SAME_TAB_LINK = { x: 110, y: 30 };
const ALT = 1;
const SHIFT = 8;
const CLICK_SETTLES_MS = 1000;

type PeekConfig = { peek?: unknown; split?: unknown; otherSitePages?: unknown };
type LastClick = { up?: boolean; clicked?: boolean; prevented?: boolean; shift?: boolean; alt?: boolean } | null;

const peekConfig = (change: Record<string, unknown>) => hostCall<PeekConfig>("peek.config", change);

async function withPeekConfig(run: () => Promise<void>) {
  const before = await peekConfig({});
  try {
    await run();
  } finally {
    await peekConfig({ peek: before.peek, split: before.split, otherSitePages: Array.isArray(before.otherSitePages) ? before.otherSitePages : [] }).catch(() => null);
  }
}

function discardingOpenedTabs(opener: string) {
  const watching = onEngineTopic("tab.opened", (event: { opener?: unknown; adopt?: unknown }) => {
    if (event.opener === opener && typeof event.adopt === "string") void hostCall("tab.discard", { adopt: event.adopt }).catch(() => null);
  });
  return () => watching.remove();
}

const framed = (page: string) => evaluate(page, 'requestAnimationFrame(() => requestAnimationFrame(() => post("result", "true")));');

type Report = { kind?: unknown; url?: unknown; outcome?: unknown; seq?: unknown };
type PeekAsked = { suppressed: boolean; heard: boolean };

const NATIVE_GATE = "The Peek window itself needs a real mouse-up through the host's native gate, which a DevTools click (Input.dispatchMouseEvent) never passes, so it is asserted with real input in the linkPeeks stage (launch-smoke.ps1)";

const reportsOf = async (page: string) => (await hostCall<{ reports?: Report[] }>("tab.links", { key: page })).reports ?? [];
const newPeek = (reports: Report[], since: number) => reports.filter((report) => Number(report.seq) > since && report.kind === "peek");

async function peekAsked(page: string, point: { x: number; y: number }, modifiers: number, label: string): Promise<PeekAsked> {
  await framed(page);
  const since = Math.max(0, ...(await reportsOf(page)).map((report) => Number(report.seq) || 0));
  await evaluate(page, 'window.lastClick = null; post("result", "true");');
  await click(page, point.x, point.y, modifiers);
  const last = await until(`the page ${page} saw the mouse-up of ${label}`, CLICK_SETTLES_MS * 5, () => evaluate(page, 'post("result", JSON.stringify(window.lastClick));') as Promise<LastClick>, (seen) => !!seen?.up);
  const reports = await until(`the engine heard a peek report for ${label}`, CLICK_SETTLES_MS * 3, () => reportsOf(page), (all) => newPeek(all, since).length > 0).catch(() => [] as Report[]);
  const heard = newPeek(reports, since).some((report) => report.outcome === "heard" && String(report.url).endsWith("/a"));
  return { suppressed: !last?.clicked || last.prevented === true, heard };
}

const notRestoredReasons = (page: string) =>
  evaluate(page, 'post("result", JSON.stringify(performance.getEntriesByType("navigation")[0]?.notRestoredReasons ?? null));').then(
    (reasons) => JSON.stringify(reasons),
    (error: unknown) => `unknown (${String(error)})`,
  );

const pageChecks = (port: string): Check[] => [
  {
    name: "engine links: the link script sees a target=_blank click on an http page served with a sandbox Content-Security-Policy (an opaque origin)",
    run: () =>
      withPages(
        ["sandboxed"],
        async ([page], windowId) => {
          await show(page!, windowId, LEFT);
          await painted(page!);
          expectEqual(await evaluate(page!, 'post("result", JSON.stringify(self.origin));'), "null", "the page's origin is opaque, so the sandbox policy took effect");
          const opened = heard("tab.opened", (event) => event.opener === page, "a new tab from a target=_blank click on the sandboxed page");
          await click(page!, BLANK_LINK.x, BLANK_LINK.y);
          const tab = await opened;
          if (typeof (tab as { adopt?: unknown }).adopt === "string") await hostCall("tab.discard", { adopt: (tab as { adopt?: unknown }).adopt }).catch(() => null);
          const downs = await evaluate(page!, 'post("result", JSON.stringify(window.downs));');
          const links = await hostCall<{ scriptFrames?: unknown; reports?: unknown }>("tab.links", { key: page }).catch((error: unknown) => ({ error: String(error) }));
          expectEqual(
            { received: Number(downs) > 0, url: String(tab.url).endsWith("/b"), fromClick: tab.fromClick },
            { received: true, url: true, fromClick: true },
            `the click reached the sandboxed page and its link script saw it (fromClick); the opened tab's url ${JSON.stringify(tab.url)}, the engine's link script contexts and recent reports ${JSON.stringify(links)}`,
          );
        },
        "links",
        LINKS_TITLE,
      ),
  },
  {
    name: "engine links: a page restored from the back/forward cache follows the Peek key set while it was cached",
    run: () =>
      withPeekConfig(() =>
        withPages(
          ["cached-peek"],
          async ([page], windowId) => {
            const stopDiscarding = discardingOpenedTabs(page!);
            try {
              await peekConfig({ peek: "alt" });
              await show(page!, windowId, LEFT);
              await painted(page!);
              expectEqual(await peekAsked(page!, SAME_TAB_LINK, ALT, "the Alt+click before caching"), { suppressed: true, heard: true }, `with Peek on Alt, the link script takes an Alt+click on a link before caching and the engine hears its peek (the check's control). ${NATIVE_GATE}`);
              await hostCall("tab.call", { key: page, method: "loadUrl", url: `http://127.0.0.1:${port}/b` });
              await until("the next page loads", LOAD_MS, () => listed(page!), (tab) => tab?.title === "loaded b" && tab.loading === false);
              await peekConfig({ peek: "shift" });
              await hostCall("tab.call", { key: page, method: "goBack" });
              await until("the links page is back", LOAD_MS, () => listed(page!), (tab) => tab?.title === LINKS_TITLE && tab.loading === false);
              const restored = await evaluate(page!, 'post("result", JSON.stringify(window.restored));');
              expectTrue(restored === true, `the links page came back from the back/forward cache (notRestoredReasons ${await notRestoredReasons(page!)})`);
              await pause(CLICK_SETTLES_MS);
              expectEqual(await peekAsked(page!, SAME_TAB_LINK, SHIFT, "the Shift+click after the restore"), { suppressed: true, heard: true }, `with Peek moved to Shift while the page was cached, the restored page's link script takes a Shift+click on a link and the engine hears its peek. ${NATIVE_GATE}`);
            } finally {
              stopDiscarding();
            }
          },
          "links",
          LINKS_TITLE,
        ),
      ),
  },
  {
    name: "engine links: a link script that outlives its DevTools session keeps working once the engine attaches again, and takes the new Peek key",
    run: () =>
      withPeekConfig(() =>
        withPages(
          ["reattach"],
          async ([page], windowId) => {
            const stopDiscarding = discardingOpenedTabs(page!);
            try {
              await peekConfig({ peek: "shift" });
              await show(page!, windowId, LEFT);
              await painted(page!);
              await hostCall("tab.call", { key: page, method: "reattachLinksForTest" });
              await until("the engine tracks the surviving link script again", LOAD_MS, async () => (await hostCall<{ scriptFrames?: unknown }>("tab.links", { key: page })).scriptFrames, (frames) => Number(frames) > 0);
              const opened = heard("tab.opened", (event) => event.opener === page, "a new tab from a target=_blank click after the engine attached again");
              await click(page!, BLANK_LINK.x, BLANK_LINK.y);
              expectEqual((await opened).fromClick, true, "the link script still saw the click after the engine attached again (fromClick)");
              await peekConfig({ peek: "alt" });
              await pause(CLICK_SETTLES_MS);
              expectEqual(await peekAsked(page!, SAME_TAB_LINK, ALT, "the Alt+click after the engine attached again"), { suppressed: true, heard: true }, `with Peek moved to Alt after the engine attached again, the surviving link script takes an Alt+click and the engine hears its peek. ${NATIVE_GATE}`);
            } finally {
              stopDiscarding();
            }
          },
          "links",
          LINKS_TITLE,
        ),
      ),
  },
];

const port = engineAvailable() ? httpPagesPort() : null;

export const checks: Check[] = port ? pageChecks(port) : [];
