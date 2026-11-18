import { engineAvailable, hostCall } from "../engine/host";
import { expectEqual, expectTrue, type Check } from "./check";
import { hide, keptBy, LEFT, listed, loaded, show, until, withPages } from "./engineSleep";

const PUT_BACK_MS = 3000;

type PageWindow = { subclassed?: unknown; holds?: unknown; before?: unknown; after?: unknown };

const pageWindow = (key: string, change: { dx?: number; dy?: number; dw?: number; dh?: number; noNotice?: boolean } = {}) => hostCall<PageWindow>("tab.call", { key, method: "moveWindowForTest", ...change });

async function holdsPlace(key: string, when: string) {
  for (const change of [{ dx: 120, dy: 60 }, { dw: -80, dh: -40 }]) {
    const moved = await pageWindow(key, change);
    expectEqual([moved.subclassed, moved.holds], [true, true], `the page window is guarded and shown ${when} (${JSON.stringify(moved)})`);
    expectEqual(moved.after, moved.before, `the page window refused ${JSON.stringify(change)} ${when}`);
  }
  const skipped = await pageWindow(key, { dx: 120, dy: 60, noNotice: true });
  await until(`the page window comes back after a move that skipped the notice ${when}`, PUT_BACK_MS, () => pageWindow(key), (now) => JSON.stringify(now.after) === JSON.stringify(skipped.before));
}

const placeChecks: Check[] = [
  {
    name: "engine sleep: a page window holds its place in the app window before it sleeps and after it wakes (#2051's guard survives a discard)",
    run: () =>
      withPages(["place"], async ([page], windowId) => {
        await show(page!, windowId, LEFT);
        await holdsPlace(page!, "before it sleeps");
        await hide(page!, windowId);
        expectEqual(await keptBy(page!, 0), [], "the hidden page sleeps");
        expectEqual((await listed(page!))?.discarded, true, "the page is discarded");
        const asleep = await pageWindow(page!);
        expectEqual([asleep.subclassed, asleep.holds], [true, false], `while it sleeps hidden its window keeps the guard but is not held (${JSON.stringify(asleep)})`);
        await show(page!, windowId, LEFT);
        await loaded(page!);
        await holdsPlace(page!, "after it wakes");
      }),
  },
];

export const checks: Check[] = engineAvailable() ? placeChecks : [];
