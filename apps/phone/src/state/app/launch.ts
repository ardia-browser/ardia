import type { InterfaceStyleChoice, SchemeChoice } from "../../lib/appearance";
import { deckSteps, LAUNCH_TIMING, TRUSTED_SITES_SAMPLE, type DeckStep, type LaunchArguments } from "../../lib/launchArguments";
import { neighbourAt } from "../../lib/pagerPhysics";
import { demoTheme } from "../../lib/themeEditor";
import { sendDeckCommand } from "../browse/deckCommands";
import { captureSnapshot, newTab, openArchive, openPage, openSpaces, openTab, showDeck, swipeOrder, switchToNeighbour, useBrowse } from "../browse/store";
import { openLibrary } from "../library/store";
import { openPageMenu, showReader } from "../page/actions";
import { presentSearch } from "../search/store";
import { startBrowseForMe } from "../browseForMe/store";
import { presentHeardVoiceSearch } from "../voice/store";
import { trustSite } from "../settings/actions";
import { openSettings, settingsRouteFromKey } from "../settings/nav";
import { acceptsPreference, type ColorChoice } from "../settings/preferences";
import { currentPreferences, setPreference } from "../settings/store";
import { closeEveryTab, closeTabById, currentTabs, openNewTab, receiveSentTabs, setIncognito, updateTabById } from "../tabs/store";
import { deckOrder } from "../tabs/tabsState";
import { showToast } from "../toasts/store";
import { pages } from "../../platform/pages";
import { launchArguments } from "./launchFlags";
import { isLabBuild } from "../../platform/lab";
import { markTiming } from "./interactionPerf";
import { runDeckPullScript } from "../browse/deckPullScript";
import { DEMO_PRIVATE_URLS, manyTabTitle, sampleToast } from "./launchRules";


const DEMO_WARM_BATCH = 3;

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export function applyLaunchSettings() {
  const args = launchArguments();
  if (!args.isDemo) return;
  if (!args.showsOnboarding) setPreference("hasFinishedOnboarding", true);
  if (args.restingStart) setPreference("autoOpensKeyboard", false);
  if (args.collapseBar) setPreference("collapsesBottomBar", true);
  const color = args.color?.toLowerCase() ?? null;
  if (color === "custom" && !currentPreferences().customTheme) setPreference("customTheme", demoTheme());
  if (color && acceptsPreference("colorChoice", color)) setPreference("colorChoice", color as ColorChoice);
  if (args.interfaceStyle && acceptsPreference("interfaceStyle", args.interfaceStyle)) setPreference("interfaceStyle", args.interfaceStyle as InterfaceStyleChoice);
  if (args.colorScheme && acceptsPreference("schemeChoice", args.colorScheme)) setPreference("schemeChoice", args.colorScheme as SchemeChoice);
}

export function runLaunchScenario() {
  const args = launchArguments();
  if (args.isDemo) void runDemoScenario(args);
  void runLaunchHooks(args);
  if (args.deckScript) void runDeckScript(args.deckScript);
  if (isLabBuild && args.browseDeckPull !== null) void runDeckPullScript(args.browseDeckPull);
}

let demoWarming: Promise<void> | null = null;

async function warmDemoPictures() {
  const pending = currentTabs().open.filter((tab) => !tab.snapshotFileName && !tab.isPrivate && /^https?:\/\//i.test(tab.url));
  for (let at = 0; at < pending.length; at += DEMO_WARM_BATCH) {
    await Promise.all(
      pending.slice(at, at + DEMO_WARM_BATCH).map(async (tab) => {
        const picture = await pages.captureOffscreen(tab.url, tab.id);
        if (!picture) return;
        updateTabById(tab.id, { snapshotFileName: picture.fileName, ...(picture.title ? { title: picture.title } : {}), ...(picture.themeColorHex ? { themeColorHex: picture.themeColorHex } : {}) });
      }),
    );
  }
}

async function runDemoScenario(args: LaunchArguments) {
  demoWarming = warmDemoPictures();
  if (args.browseIncognito && !setIncognito(true)) return;
  if (args.browseOpen) openPage(args.browseOpen, "typed");
  if (args.browseQuery !== null) presentSearch("home", args.browseQuery);
  if (args.browseSurface === "browsing") {
    const open = currentTabs().open;
    const chosen = (args.browseTab !== null ? open[args.browseTab]?.id : null) ?? currentTabs().selectedId;
    if (chosen) openTab(chosen);
  }
  await wait(args.browseDelayMs);
  if (args.browseToolbar) void openPageMenu();
  if (args.browseOverlay !== null) presentSearch("page", args.browseOverlay);
  if (args.browseReader) showReader();
  if (args.browseDeck) {
    void showDeck();
    if (args.browseDeckOpen !== null) {
      await wait(LAUNCH_TIMING.deckOpenMs);
      const tab = currentTabs().open[args.browseDeckOpen];
      if (tab) openTab(tab.id);
    }
  }
  if (args.browsePlus) {
    await wait(args.browseDelayMs);
    newTab();
  }
  for (const step of args.browseSteps) {
    const id = neighbourAt(swipeOrder(), currentTabs().selectedId, step);
    if (id) switchToNeighbour(id);
    await wait(args.browseStepGapMs);
  }
}

async function runLaunchHooks(args: LaunchArguments) {
  if (args.trustedSitesSample) for (const host of TRUSTED_SITES_SAMPLE) void trustSite(host, true);
  if (!args.opensSettings && args.settingsPage === null && args.openSheet === null && args.toast === null && args.browseResearch === null && args.voiceHeard === null) return;
  await wait(LAUNCH_TIMING.sheetMs);
  if (args.browseResearch !== null) startBrowseForMe(args.browseResearch);
  if (args.voiceHeard !== null) presentHeardVoiceSearch(args.voiceHeard);
  if (args.opensSettings || args.openSheet === "settings") openSettings();
  const page = args.settingsPage === null ? null : settingsRouteFromKey(args.settingsPage);
  if (page) openSettings(page);
  if (args.openSheet === "archive") openArchive();
  if (args.openSheet === "spaces") openSpaces();
  if (args.openSheet === "history" || args.openSheet === "bookmarks" || args.openSheet === "downloads") openLibrary(args.openSheet);
  if (args.toast === null) return;
  await wait(LAUNCH_TIMING.toastMs - LAUNCH_TIMING.sheetMs);
  const toast = sampleToast(args.toast);
  if (toast) showToast(toast.message, toast.icon);
}

async function runDeckScript(script: string) {
  await wait(LAUNCH_TIMING.deckScriptStartMs);
  for (const step of deckSteps(script)) await deckStep(step);
}

async function deckStep({ kind, argument }: DeckStep) {
  switch (kind) {
    case "wait":
      await wait((Number(argument) || 1) * 1000);
      return;
    case "deck":
    case "switcher":
      await showDeck();
      return;
    case "open": {
      const selected = currentTabs().selectedId;
      if (useBrowse.getState().surface !== "browsing" && selected) {
        openTab(selected);
        await wait(OPEN_SETTLE_MS);
      }
      await showDeck();
      return;
    }
    case "snapall":
      await snapshotTabs(deckOrder(currentTabs()).slice(-(Number(argument) || 6)).map((tab) => tab.id));
      return;
    case "warm":
      await demoWarming;
      await snapshotTabs(currentTabs().open.filter((tab) => !tab.snapshotFileName).map((tab) => tab.id));
      return;
    case "scroll":
      sendDeckCommand({ kind: "scroll", index: Number(argument) || 0 });
      return;
    case "close":
      sendDeckCommand({ kind: "closeFocused" });
      return;
    case "tap":
      sendDeckCommand({ kind: "openFocused" });
      return;
    case "lift":
      sendDeckCommand({ kind: "lift", offset: argument !== null && Number.isFinite(Number(argument)) ? Number(argument) : DEFAULT_LIFT });
      return;
    case "archivecard":
      sendDeckCommand({ kind: "showArchiveCard" });
      return;
    case "switch": {
      const order = deckOrder(currentTabs());
      const at = order.findIndex((tab) => tab.id === currentTabs().selectedId);
      const other = order[at > 0 ? at - 1 : at + 1];
      if (!other || useBrowse.getState().surface !== "browsing") return;
      openTab(other.id);
      await wait((Number(argument) || 0) * 1000);
      await showDeck();
      return;
    }
    case "browse": {
      const selected = currentTabs().selectedId;
      if (selected) openTab(selected);
      return;
    }
    case "goincognito":
      setIncognito(true);
      return;
    case "goregular":
      setIncognito(false);
      return;
    case "incognito":
      for (const url of DEMO_PRIVATE_URLS) openNewTab({ url, origin: "typed", isPrivate: true });
      await showDeck();
      return;
    case "keep": {
      const order = deckOrder(currentTabs());
      for (const tab of order.slice(0, Math.max(0, order.length - (Number(argument) || 3)))) closeTabById(tab.id);
      return;
    }
    case "private": {
      const tab = openNewTab({ url: DEMO_PRIVATE_URLS[0], origin: "typed", isPrivate: true, selecting: false });
      updateTabById(tab.id, { title: "Moon - Wikipedia" });
      return;
    }
    case "empty":
      closeEveryTab();
      await showDeck();
      return;
    case "archive":
      openArchive();
      return;
    case "spaces":
      openSpaces();
      return;
    case "received":
      receiveSentTabs([
        { key: `demo-received-${Date.now()}`, url: "https://www.swift.org/blog/", title: "Blog | Swift.org", fromDevice: "MacBook Pro", sentAt: Date.now(), profileSyncId: "demo-personal" },
      ]);
      return;
    case "many":
      for (let index = 0; index < (Number(argument) || 50); index++) {
        const tab = openNewTab({ url: `https://en.wikipedia.org/wiki/Special:Random?n=${index}`, origin: "typed", isPrivate: false, selecting: false });
        updateTabById(tab.id, { title: manyTabTitle(index) });
      }
      return;
    case "scheme":
      if (!argument || !acceptsPreference("schemeChoice", argument)) return;
      markTiming(`scheme ${argument}`);
      setPreference("schemeChoice", argument as SchemeChoice);
      return;
    case "color":
      if (!argument || !acceptsPreference("colorChoice", argument)) return;
      markTiming(`color ${argument}`);
      setPreference("colorChoice", argument as ColorChoice);
      return;
    case "swipe": {
      const id = neighbourAt(swipeOrder(), currentTabs().selectedId, Number(argument) || 1);
      if (!id) return;
      markTiming("tab swipe");
      switchToNeighbour(id, true);
      return;
    }
    case "plus":
      markTiming("plus press");
      newTab();
      return;
    default:
      console.log(`ardia-launch deck step ${kind} is unknown; skipped`);
  }
}

const OPEN_SETTLE_MS = 1000;
const DEFAULT_LIFT = -120;

async function snapshotTabs(ids: readonly string[]) {
  for (const id of ids) {
    openTab(id);
    await wait(LAUNCH_TIMING.snapWaitMs);
    await captureSnapshot(id);
  }
  const last = ids.at(-1);
  if (last) openTab(last);
}
