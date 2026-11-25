import type { WindowsNative } from "@ardia/shell";
import { engineAvailable, hostCall } from "../engine/host";
import { requireNativeModule } from "../modules";
import type { DialogsModule, MenusModule } from "../nativeModuleTypes";
import { expectTrue, type Check } from "./check";
import { pageLoads } from "./heldDialogs";

const LOAD_MS = 8000;
const STALLED_MS = 3000;
const SHOWN_MS = 4000;
const CLOSED_MS = 1000;
const GIVE_UP_MS = 5000;

const menus = () => requireNativeModule<Pick<MenusModule, "openCount" | "devHoldMenu">>("ArdiaMenus");
const dialogs = () => requireNativeModule<Pick<DialogsModule, "devReleaseDialogs">>("ArdiaDialogs");
const windows = () => requireNativeModule<Pick<WindowsNative, "windowIds" | "openWindow" | "closeWindow">>("ArdiaAppWindows");
const MENU_OWNER = "self-check-menu-owner";
const settled = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function menuCountReaches(count: number, withinMs: number) {
  for (let waited = 0; waited < withinMs; waited += 100) {
    if (menus().openCount() === count) return true;
    await settled(100);
  }
  return false;
}

async function releaseMenu(held: Promise<boolean>, withinMs: number) {
  let pick: boolean | undefined;
  void held.then((result) => (pick = result)).catch(() => undefined);
  for (let waited = 0; waited < withinMs && pick === undefined; waited += 100) {
    dialogs().devReleaseDialogs();
    await settled(100);
  }
  return pick;
}

async function loadWhileMenuHeld(onUiThread: boolean, key: string, withinMs: number) {
  const [pageWindowId] = await windows().windowIds();
  expectTrue(pageWindowId, "no window is open to host the page");
  await windows().openWindow(MENU_OWNER, { kind: "import", title: "Self check", focus: false });
  let held: Promise<boolean> = Promise.resolve(false);
  let created: Promise<unknown> = Promise.resolve();
  try {
    await settled(300);
    held = menus().devHoldMenu(MENU_OWNER, onUiThread);
    expectTrue(await menuCountReaches(1, SHOWN_MS), "the held menu never opened");
    const title = `held menu ${key}`;
    const loaded = pageLoads(key, title, withinMs);
    created = hostCall("tab.create", { key, url: `data:text/html,<title>${title}</title><p>loaded while a menu was open</p>`, profile: "" }, pageWindowId).catch(() => undefined);
    const didLoad = await loaded;
    expectTrue(menus().openCount() === 1, "the held menu closed before the page check ended, so it proves nothing");
    return didLoad;
  } finally {
    const pick = await releaseMenu(held, GIVE_UP_MS);
    await created;
    await hostCall("tab.close", { key }).catch(() => undefined);
    await windows().closeWindow(MENU_OWNER).catch(() => undefined);
    expectTrue(pick !== undefined, `the held menu was still open ${GIVE_UP_MS} ms after its release`);
    expectTrue(pick === false, "the released menu reported a pick");
  }
}

export const checks: Check[] = [
  {
    name: "a pop-up menu runs on its own thread: with one open in one window, a page created in another window meanwhile loads",
    async run() {
      if (!engineAvailable()) return;
      expectTrue(await loadWhileMenuHeld(false, "held-menu-own-thread", LOAD_MS), `the page didn't load within ${LOAD_MS} ms while a menu was open`);
      expectTrue(await menuCountReaches(0, CLOSED_MS), "the released menu is still counted as open");
    },
  },
  {
    name: "the control: the same menu on the UI thread stalls Chromium, so the page waits until it closes",
    async run() {
      if (!engineAvailable()) return;
      expectTrue(!(await loadWhileMenuHeld(true, "held-menu-ui-thread", STALLED_MS)), "the page loaded while a menu held the UI thread: this check no longer tells a stalled UI thread apart");
    },
  },
];
