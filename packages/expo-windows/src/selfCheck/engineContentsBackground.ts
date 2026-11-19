import { engineAvailable, hostCall } from "../engine/host";
import { requireNativeModule } from "../modules";
import type { AppWindowsModule, PageColors } from "../nativeModuleTypes";
import { httpPagesPort } from "./engineBackForward";
import type { Check } from "./check";
import { firstWindow, listed, pause, until } from "./engineSleep";

const DARK = "#1E2A38";
const LIGHT = "#E8E0D0";
const WHITE = "#FFFFFF";
const PAGE = "#3080F0";
const DARK_CANVAS = "#121212";
const PLACE = { x: 0, y: 40, width: 320, height: 240 };
const INSET = 24;
const NEAR = 4;
const MOSTLY = 0.9;
const SETTLE_MS = 20000;
const COLOR_MS = 6000;
const HELD_MS = 3000;
const SAMPLE_MS = 250;
const LOG = "[ardia windows] contents background:";

const port = engineAvailable() ? httpPagesPort() : null;
const native = () => requireNativeModule<Pick<AppWindowsModule, "debugPageColors">>("ArdiaAppWindows");

const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
const near = (a: string, b: string) => channels(a).every((value, i) => Math.abs(value - channels(b)[i]!) <= NEAR);
const shareOf = (colors: PageColors | null, wanted: string) => (colors?.most ?? []).filter((entry) => near(entry.color, wanted)).reduce((sum, entry) => sum + entry.share, 0);
const describe = (colors: PageColors | null) => (colors ? colors.most.slice(0, 3).map((entry) => `${entry.color} ${(entry.share * 100).toFixed(1)}%`).join(", ") : "no capture");

class Findings {
  private readonly failures: string[] = [];
  constructor(private readonly name: string) {}
  note(line: string) {
    console.info(`${LOG} ${this.name}: ${line}`);
  }
  expect(ok: unknown, what: string) {
    this.note(`${ok ? "ok" : "FAILED"} ${what}`);
    if (!ok) this.failures.push(what);
  }
  async step(what: string, run: () => Promise<void>) {
    try {
      await run();
    } catch (error) {
      this.expect(false, `${what}: ${String((error as Error)?.message ?? error)}`);
    }
  }
  finish() {
    if (this.failures.length) throw new Error(`${this.failures.length} failed: ${this.failures.join(" | ")}`);
  }
}

async function pageColors(windowId: string) {
  return native().debugPageColors(windowId, PLACE.x + INSET, PLACE.y + INSET, PLACE.width - 2 * INSET, PLACE.height - 2 * INSET);
}

async function shows(findings: Findings, windowId: string, wanted: string, what: string) {
  const by = Date.now() + COLOR_MS;
  let colors = await pageColors(windowId);
  while (shareOf(colors, wanted) < MOSTLY && Date.now() < by) {
    await pause(SAMPLE_MS);
    colors = await pageColors(windowId);
  }
  findings.expect(shareOf(colors, wanted) >= MOSTLY, `${what}: the page area is ${wanted} (${describe(colors)})`);
}

async function withBlankTab(name: string, background: string | undefined, dark: boolean, run: (findings: Findings, key: string, windowId: string) => Promise<void>) {
  const findings = new Findings(name);
  const key = `self-check-contents-background-${name}`;
  const profile = `incognito-contents-background-${name}@`;
  const windowId = await firstWindow();
  const colored = background ? { contentsBackground: background } : {};
  try {
    await hostCall("tab.create", { key, url: "", profile, ...colored }, windowId);
    await until(`the tab ${key} settles on its blank page`, SETTLE_MS, () => listed(key), (tab) => tab?.url === "about:blank" && tab.loading === false);
    if (dark) await hostCall("tab.call", { key, method: "preferDarkForTest", dark: true });
    findings.note(`Chromium's dark preference ${dark ? "on" : "off"}`);
    await hostCall("tab.show", { key, visible: true, ...PLACE, radius: 0, holes: [], ...colored }, windowId);
    await run(findings, key, windowId);
  } catch (error) {
    findings.expect(false, `setup: ${String((error as Error)?.message ?? error)}`);
  } finally {
    await hostCall("tab.show", { key, visible: false }, windowId).catch(() => null);
    await hostCall("tab.close", { key }).catch(() => null);
    await hostCall("profile.release", { profile }).catch(() => null);
  }
  findings.finish();
}

async function heldNavigation(findings: Findings, key: string, windowId: string, background: string) {
  const token = `cb${Date.now().toString(36)}`;
  const address = `http://127.0.0.1:${port}/painted?holdonce=${token}`;
  await fetch(address).catch(() => null);
  await hostCall("tab.call", { key, method: "loadUrl", url: address });
  const heldUntil = Date.now() + HELD_MS;
  let samples = 0;
  let off = 0;
  let worst = "";
  while (Date.now() < heldUntil) {
    const colors = await pageColors(windowId);
    samples += 1;
    if (shareOf(colors, background) < MOSTLY) {
      off += 1;
      worst = describe(colors);
    }
    await pause(SAMPLE_MS);
  }
  const tab = await listed(key);
  findings.expect(tab?.loading === true, `the held navigation is still loading after ${HELD_MS} ms (${JSON.stringify(tab)})`);
  findings.expect(samples > 0 && off === 0, `${samples - off} of ${samples} samples during the held response show ${background}${off ? ` (one was ${worst})` : ""}`);
  await fetch(`http://127.0.0.1:${port}/release?holdonce=${token}`).catch(() => null);
  await until(`the painted page loads in ${key}`, SETTLE_MS, () => listed(key), (loaded) => loaded?.title === "painted page" && loaded.loading === false);
  await shows(findings, windowId, PAGE, "after the page draws, its own colour shows");
  const plain = `http://127.0.0.1:${port}/a`;
  await hostCall("tab.call", { key, method: "loadUrl", url: plain });
  await until(`the page with no background loads in ${key}`, SETTLE_MS, () => listed(key), (loaded) => loaded?.title === "loaded a" && loaded.loading === false);
  await shows(findings, windowId, WHITE, "a committed page with no background of its own shows Chromium's white canvas, not the card colour");
}

function colorChecks(name: string, background: string, dark: boolean): Check {
  return {
    name: `engine contents background: a blank tab made with the ${name} card colour, Chromium's dark preference ${dark ? "on" : "off"}, shows it until a held page commits, then the page, then a plain page's white`,
    run: () =>
      withBlankTab(`${name}${dark ? "-dark-preference" : ""}`, background, dark, async (findings, key, windowId) => {
        await findings.step("the blank shows the card colour", () => shows(findings, windowId, background, "the shown blank"));
        await findings.step("a held navigation keeps it until the commit", () => heldNavigation(findings, key, windowId, background));
      }),
  };
}

const contentsBackgroundChecks: Check[] = [
  colorChecks("dark", DARK, false),
  colorChecks("light", LIGHT, false),
  colorChecks("dark", DARK, true),
  colorChecks("light", LIGHT, true),
  {
    name: "engine contents background: a tab made and shown without the argument keeps Chromium's white blank",
    run: () => withBlankTab("plain", undefined, false, (findings, _key, windowId) => findings.step("the plain blank", () => shows(findings, windowId, WHITE, "a tab without contentsBackground"))),
  },
  {
    name: "engine contents background: with Chromium's dark preference on, a tab without the argument keeps Chromium's dark blank",
    run: () => withBlankTab("plain-dark-preference", undefined, true, (findings, _key, windowId) => findings.step("the plain dark blank", () => shows(findings, windowId, DARK_CANVAS, "a tab without contentsBackground under the dark preference"))),
  },
  {
    name: "engine contents background: DevTools attaching ends the coloured blank",
    run: () =>
      withBlankTab("devtools", DARK, false, async (findings, key, windowId) => {
        await findings.step("before DevTools", () => shows(findings, windowId, DARK, "before DevTools attaches"));
        await findings.step("DevTools attaches", async () => {
          await hostCall("tab.call", { key, method: "testClient", attach: true });
          await shows(findings, windowId, WHITE, "after DevTools attaches, the blank is Chromium's white again");
        });
        await hostCall("tab.call", { key, method: "testClient", attach: false }).catch(() => null);
      }),
  },
  {
    name: "engine contents background: a colour that is not #RRGGBB in capitals is refused by tab.create and tab.show",
    run: () =>
      withBlankTab("refused", DARK, false, async (findings, key, windowId) => {
        const windowIdForCreate = windowId;
        for (const bad of ["#1e2a38", "1E2A38", "#1E2A3", "#1E2A38FF", "red"]) {
          await findings.step(`tab.create with ${bad}`, async () => {
            const refused = await hostCall("tab.create", { key: `${key}-bad`, url: "", contentsBackground: bad }, windowIdForCreate).then(
              () => false,
              () => true,
            );
            findings.expect(refused, `tab.create refuses ${JSON.stringify(bad)}`);
            await hostCall("tab.close", { key: `${key}-bad` }).catch(() => null);
          });
          await findings.step(`tab.show with ${bad}`, async () => {
            const refused = await hostCall("tab.show", { key, visible: true, ...PLACE, radius: 0, holes: [], contentsBackground: bad }, windowId).then(
              () => false,
              () => true,
            );
            findings.expect(refused, `tab.show refuses ${JSON.stringify(bad)}`);
          });
        }
        await findings.step("the tab keeps its colour after the refusals", () => shows(findings, windowId, DARK, "after refused colours"));
      }),
  },
];

export const checks: Check[] = port ? contentsBackgroundChecks : [];
