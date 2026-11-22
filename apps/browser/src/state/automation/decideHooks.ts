import { moveCompletedDownload, setApprovedDownloadFolders, setHoldIncomingLinks } from "../../platform/systemSignals";
import { isFields } from "../../lib/decode";
import { setOpeningGate, type OpeningContext, type OpeningVerdict } from "../tabs/openingGate";
import { setLinkGate, type LinkGateResult, type LinkSourceInfo } from "../littleArdia/linkGate";
import { setPermissionGate, type PermissionAsk } from "../site/permissionGate";
import { useBrowser } from "../browser/store";
import { isIncognitoProfile } from "../browser/model";
import { cancelAllDecisions } from "./decideSocket";
import { decideLink, decideOpening, decidePermission, profileNamed, type LinkVerdict, type PermissionVerdict } from "./decisions";
import { eligibleKind, isEligibleTab } from "./automationWindows";
import { safeRewriteTarget } from "./hookPolicy";
import { activeHook, decideHooks, onHooksChanged, startHookRules, useHookRules } from "./hookRules";
import { startOmniboxApprovals } from "./omniboxApprovals";
import { startOmniboxHooks } from "./omniboxHooks";
import { startDownloadHooks } from "./downloadHooks";
import { airTrafficHolds } from "../airTraffic/rules";
import { currentAirTraffic, loadAirTraffic, noteLinkSource, useAirTraffic } from "../airTraffic/store";
import { onPluginDecidersChanged, pluginsDeciding, runPluginDecideHook } from "../plugins/decideHooks";
import { usePlugins } from "../plugins/store";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { t } from "../../lib/uiLanguage";


const LINK_OPEN = new Set(["tab", "littleArdia", "window"]);

function pluginEligible(windowId: string | null, profileId: string | null, tabId: string | null = null): boolean {
  const s = useBrowser.getState();
  if (profileId && isIncognitoProfile(profileId)) return false;
  if (tabId && s.tabs[tabId] && !isEligibleTab(s, tabId)) return false;
  if (windowId && s.windows[windowId] && !eligibleKind(s, windowId)) return false;
  return true;
}

function afterHooks<T>(declared: T | null | Promise<T | null>, event: string, eligible: boolean, ask: () => Promise<T | null>): T | null | Promise<T | null> {
  if (!eligible || !pluginsDeciding(event).length) return declared;
  if (declared instanceof Promise) return declared.then((v) => v ?? ask());
  return declared ?? ask();
}

function pluginOpening(url: string, verdict: unknown): OpeningVerdict {
  if (!isFields(verdict)) return null;
  if (verdict.cancel === true) return { cancel: true };
  const target = typeof verdict.url === "string" ? safeRewriteTarget(verdict.url) : null;
  return target && target !== url ? { url: target } : null;
}

function openingWithPlugins(url: string, context: OpeningContext, consent: ConsentToken | null, signal?: AbortSignal): OpeningVerdict | Promise<OpeningVerdict> {
  const data = { url, via: context.via, windowId: context.windowId, tabId: context.tabId, profile: context.profileId };
  return afterHooks(decideOpening(url, context, signal), "tab.opening", pluginEligible(context.windowId, context.profileId, context.tabId), () =>
    runPluginDecideHook("tab.opening", data, consent, signal).then((found) => (found ? pluginOpening(url, found.verdict) : null)),
  );
}

function pluginLink(verdict: unknown): LinkVerdict | null {
  if (!isFields(verdict)) return null;
  if (verdict.drop === true) return { drop: true };
  const profileId = verdict.profile === undefined ? null : profileNamed(verdict.profile);
  if (verdict.profile !== undefined && !profileId) return null;
  const open = typeof verdict.open === "string" && LINK_OPEN.has(verdict.open) ? (verdict.open as "tab" | "littleArdia" | "window") : null;
  if (verdict.open !== undefined && !open) return null;
  return profileId || open ? { profileId, open, windowId: null, groupKey: null } : null;
}

function linkWithPlugins(url: string, source: LinkSourceInfo, consent: ConsentToken | null): LinkVerdict | null | Promise<LinkVerdict | null> {
  const data = { url, source: source ?? { bundleId: null, appName: null } };
  return afterHooks(decideLink(url, source), "link.opening", true, () => runPluginDecideHook("link.opening", data, consent).then((found) => (found ? pluginLink(found.verdict) : null)));
}

function permissionWithPlugins(request: PermissionAsk, signal?: AbortSignal): PermissionVerdict | Promise<PermissionVerdict> {
  const consent = consentToken();
  const declared = decidePermission(request, signal);
  const tab = request.tabId ? useBrowser.getState().tabs[request.tabId] : undefined;
  if (!tab || !pluginEligible(tab.windowId, tab.profileId, tab.id) || !pluginsDeciding("permission.requested").length) return declared;
  const data = { origin: request.origin, kinds: request.permissions, windowId: tab.windowId, tabId: tab.id, profile: tab.profileId };
  const ask = () => runPluginDecideHook("permission.requested", data, consent, signal).then((found): PermissionVerdict => (isFields(found?.verdict) && found.verdict.permission === "deny" ? "deny" : "ask"));
  if (declared instanceof Promise) return declared.then((v) => (v === "deny" ? v : ask()));
  return declared === "deny" ? declared : ask();
}

function linkResult(url: string, verdict: LinkVerdict | null): LinkGateResult {
  if (!verdict) return { url, route: null, decided: true };
  if ("drop" in verdict) return null;
  return { url, route: verdict, decided: true };
}

function gateLink(url: string, source: LinkSourceInfo): LinkGateResult | Promise<LinkGateResult> {
  noteLinkSource(source);
  const consent = consentToken();
  const opening = openingWithPlugins(url, { tabId: null, windowId: null, profileId: null, via: "external" }, consent);
  const route = (verdict: Awaited<typeof opening>): LinkGateResult | Promise<LinkGateResult> => {
    if (verdict && "cancel" in verdict) return null;
    const target = verdict?.url ?? url;
    const linked = linkWithPlugins(target, source, consent);
    return linked instanceof Promise ? linked.then((v) => linkResult(target, v)) : linkResult(target, linked);
  };
  return opening instanceof Promise ? opening.then(route) : route(opening);
}

const pluginsHoldLinks = () => pluginsDeciding("link.opening").length > 0 || pluginsDeciding("tab.opening").length > 0;

function updateLinkHold() {
  const wanted = airTrafficHolds(currentAirTraffic()) || [...decideHooks("link.opening"), ...decideHooks("tab.opening")].some(activeHook) || pluginsHoldLinks();
  try {
    setHoldIncomingLinks(wanted, useHookRules.getState().stamp);
  } catch (error) {
    console.warn(t(`[automation] couldn't set the incoming link hold`), error);
  }
}

let started = false;

export function startDecideHooks() {
  if (started) return;
  started = true;
  startOmniboxApprovals();
  startHookRules();
  startOmniboxHooks();
  startDownloadHooks({ move: moveCompletedDownload, approveFolders: setApprovedDownloadFolders });
  setOpeningGate((url, context, signal) => openingWithPlugins(url, context, consentToken(), signal));
  setLinkGate(gateLink);
  setPermissionGate((request, signal) => permissionWithPlugins(request, signal));
  onHooksChanged(() => {
    cancelAllDecisions();
    updateLinkHold();
  });
  useHookRules.subscribe((s, prev) => {
    if (s.stamp !== prev.stamp) updateLinkHold();
  });
  let pluginHold = pluginsHoldLinks();
  const refreshPluginHold = () => {
    const now = pluginsHoldLinks();
    if (now === pluginHold) return;
    pluginHold = now;
    updateLinkHold();
  };
  usePlugins.subscribe(refreshPluginHold);
  onPluginDecidersChanged(refreshPluginHold);
  loadAirTraffic();
  useAirTraffic.subscribe((s, prev) => {
    if (airTrafficHolds(s.config) !== airTrafficHolds(prev.config)) updateLinkHold();
  });
  updateLinkHold();
}
