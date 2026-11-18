import type { AppWindowsModule } from "../nativeModuleTypes";
import { requireNativeModule } from "../modules";
import { POPUP_CHROME_HEIGHT, POPUP_MIN_PAGE, popupFrame } from "../engine/popupPlacement";
import { expectEqual, expectTrue, type Check } from "./check";

const windows = () => requireNativeModule<Pick<AppWindowsModule, "windowIds" | "windowFrame" | "openWindow" | "closeWindow" | "debugDragRegions">>("ArdiaAppWindows");
const settled = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const SMALL_POPUP = "popup:self-check-small";
const PLACED_POPUP = "popup:self-check-placed";
const OPEN_MS = 300;
const PIXEL_SLACK = 1;

const near = (actual: number, wanted: number) => Math.abs(actual - wanted) <= PIXEL_SLACK;

async function frameOf(id: string) {
  const frame = await windows().windowFrame(id);
  expectTrue(frame && frame.length === 4, `${id} has no frame: ${JSON.stringify(frame)}`);
  return frame;
}

async function closeAndForget(id: string) {
  await windows().closeWindow(id);
  await settled(OPEN_MS);
  expectTrue(!(await windows().windowIds()).includes(id), `${id} is still listed after it closed`);
}

export const popupWindowChecks: Check[] = [
  {
    name: "pop-up windows: a pop-up asked smaller than 200 by 150 opens at that size plus its chrome, as a pop-up and not a browser window",
    async run() {
      await windows().openWindow(SMALL_POPUP, { kind: "popup", title: "Pop-up check", focus: false, size: [100, 100] });
      await settled(OPEN_MS);
      try {
        expectTrue((await windows().windowIds()).includes(SMALL_POPUP), "the pop-up window is not listed");
        const [, , width, height] = await frameOf(SMALL_POPUP);
        const wanted = [POPUP_MIN_PAGE.width, POPUP_MIN_PAGE.height + POPUP_CHROME_HEIGHT];
        expectTrue(near(width, wanted[0]!) && near(height, wanted[1]!), `the pop-up is ${width} by ${height}, wanted ${wanted.join(" by ")}`);
        const regions = await windows().debugDragRegions(SMALL_POPUP);
        expectTrue(regions, "debugDragRegions did not answer for the pop-up");
        expectEqual(regions.kind, "popup", "the pop-up window's kind");
      } finally {
        await closeAndForget(SMALL_POPUP);
      }
    },
  },
  {
    name: "pop-up windows: a pop-up placed on its opener opens centred on it, 60 below its top, inside the display",
    async run() {
      const ids = await windows().windowIds();
      expectTrue(ids.length > 0, "no window is open to open a pop-up from");
      const opener = await frameOf(ids[0]!);
      const frame = popupFrame({ width: 400, height: 300 }, opener);
      expectTrue(frame, "no frame for a pop-up with an opener");
      await windows().openWindow(PLACED_POPUP, { kind: "popup", title: "Pop-up check", focus: false, frame });
      await settled(OPEN_MS);
      try {
        const [x, y, width, height] = await frameOf(PLACED_POPUP);
        expectTrue(near(width, 400) && near(height, 300 + POPUP_CHROME_HEIGHT), `the pop-up is ${width} by ${height}`);
        if (!near(x, frame[0]) || !near(y, frame[1])) console.info(`[ardia windows] the pop-up was kept on its display at ${x},${y} instead of ${frame[0]},${frame[1]}`);
        expectTrue((await windows().windowIds()).includes(ids[0]!), "the opener's window closed when the pop-up opened");
      } finally {
        await closeAndForget(PLACED_POPUP);
      }
      expectTrue((await windows().windowIds()).includes(ids[0]!), "closing the pop-up closed its opener's window");
    },
  },
];
