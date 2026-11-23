import { useEffect } from "react";
import { Animated, StyleSheet, type ViewStyle } from "react-native";
import { ENGINE_OFFER_WIDTH, EngineOfferPrompt } from "../site/EnginePrompt";
import { ControlPill } from "./ControlPill";
import { LoadingPill } from "./LoadingPill";
import { NewTabNotice } from "./NewTabNotice";
import { FindBar } from "../find/FindBar";
import { POPOVER_MARGIN, usePanelsPresence, type PanelPresence } from "../ui";
import { NO_TOOLBAR, type ToolbarGeometry } from "./geometry";
import { usePage, usePages } from "../../state/tabs/pageState";
import { PLUGIN_CHROME, usePluginChrome } from "../../state/plugins/chrome";
import { startPopoverEscape } from "../../state/tabs/popoverDismiss";
import { SadTab, StatusBubble } from "./PaneOverlays";
import { AutofillPrompt, BLOCKED_POPUPS_WIDTH, BlockedPopupsPrompt, EXTERNAL_APP_WIDTH, ExternalAppPrompt, PasswordPrompt, PERMISSION_PROMPT_WIDTH, PermissionPrompt, VerificationCodePrompt } from "../site/Prompts";
import { SiteControlsPanel } from "../site/SiteControls";
import { SITE_PANEL } from "../site/SiteControlsParts";
import { ZOOM_POPOVER_WIDTH, ZoomPanel } from "../site/ZoomControls";
import { HIDDEN_ELEMENTS_WIDTH, HiddenElementsPanel } from "../site/HiddenElements";
import { SelectionPopover } from "../site/SelectionPopover";
import { SharePicker } from "../media/SharePicker";
import { CastPicker } from "../media/CastPicker";
import { DEVICE_CHOOSER_WIDTH, DeviceChooser } from "../site/DeviceChooser";
import { SwipeOverlay } from "./SwipeOverlay";
import { HISTORY_MENU_WIDTH, HistoryPopover, underButton } from "./HistoryPopover";
import { TabWebView } from "./TabWebView";
import { fitLeft, historyMenuLeft, pageSurfaceLeft, type PageAnchor, type PageSurface } from "./pageAnchors";
import { useFindOpen, useSidebarSide } from "../../state/browser/hooks";
import { useLastingLoad } from "../../state/tabs/lastingLoad";
import { useControlIndicator } from "../../state/app/programControl";
import { useNewTabNotices } from "../../state/tabs/newTabNotice";
import { useEngineOffers } from "../../state/engines/actions";
import { useMedia } from "../../state/media/media";
import { useDeviceChooserOpen } from "../../state/site/deviceChoosers";
import { useCast } from "../../state/media/cast";
import { useHistoryMenu } from "../../state/tabs/navigation";
import { usePageSelection } from "../../state/site/selection";
import { BEHIND_NEW_TAB, OVERLAY, overlayBits, pageOverlays, useEligibleGate, useKeptOverlays, useKeptWhile } from "./overlayGate";

export function PageOverlays({
  tabId,
  windowId,
  width,
  geometry,
  toolbar,
  newTabShown,
  statusStyle,
  popovers = true,
  cliPill = false,
  loadingPill = true,
}: {
  tabId: string;
  windowId: string;
  width: number;
  geometry: ToolbarGeometry;
  toolbar: boolean;
  newTabShown: boolean;
  statusStyle?: Animated.WithAnimatedValue<ViewStyle>;
  popovers?: boolean;
  cliPill?: boolean;
  loadingPill?: boolean;
}) {
  const popover = usePages((s) => s.popover[tabId] ?? null);
  const panel = usePanelsPresence(popover, SITE_PANELS);
  const blockedPopups = useKeptWhile(popover === "popups", popovers);
  const verificationCodes = usePluginChrome(PLUGIN_CHROME.verificationCodes);
  const sidebarRight = useSidebarSide(windowId) === "right";
  const anchor: PageAnchor = { toolbar: toolbar ? geometry : null, sidebarRight };
  const at = (surface: PageSurface, surfaceWidth: number) => ({ left: pageSurfaceLeft(anchor, surface, width, surfaceWidth), top: POPOVER_MARGIN });
  const lasting = useLastingLoad(tabId, loadingPill && !newTabShown);
  const on = usePageOverlays(tabId, windowId, popovers) | (lasting ? OVERLAY.loading : 0);
  const shown = on & ~(newTabShown ? BEHIND_NEW_TAB : 0) & ~(verificationCodes ? 0 : OVERLAY.verificationCode) & ~(cliPill ? 0 : OVERLAY.control) & ~OVERLAY.selection;
  const overlays = useKeptOverlays(on & ~OVERLAY.control, shown);
  const control = useEligibleGate((on & OVERLAY.control) !== 0, cliPill);
  const has = overlays.has;
  useEffect(startPopoverEscape, []);
  return (
    <>
      {has("find") && <FindBar tabId={tabId} />}
      {has("status") && (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, statusStyle]}>
          <StatusBubble tabId={tabId} maxWidth={Math.max(160, width / 2)} enter={overlays.entersLater("status")} />
        </Animated.View>
      )}
      {has("sadTab") && <SadTab tabId={tabId} />}
      {!newTabShown && loadingPill && has("loading") && <LoadingPill loading={lasting} />}
      {cliPill && control.mounted && <ControlPill style={statusStyle} enter={control.enter} />}
      {!newTabShown && has("permission") && <PermissionPrompt tabId={tabId} {...at("prompt", PERMISSION_PROMPT_WIDTH)} />}
      {has("password") && <PasswordPrompt tabId={tabId} right={POPOVER_MARGIN} top={POPOVER_MARGIN} />}
      {has("autofill") && <AutofillPrompt tabId={tabId} right={POPOVER_MARGIN} top={POPOVER_MARGIN} />}
      {verificationCodes && has("verificationCode") && <VerificationCodePrompt tabId={tabId} right={POPOVER_MARGIN} top={POPOVER_MARGIN} />}
      {has("newTabNotice") && <NewTabNotice windowId={windowId} tabId={tabId} right={POPOVER_MARGIN} top={POPOVER_MARGIN} enter={overlays.entersLater("newTabNotice")} />}
      {!newTabShown && has("externalApp") && <ExternalAppPrompt tabId={tabId} {...at("prompt", EXTERNAL_APP_WIDTH)} />}
      {!newTabShown && has("engineOffer") && <EngineOfferPrompt tabId={tabId} {...at("prompt", ENGINE_OFFER_WIDTH)} />}
      {blockedPopups && <BlockedPopupsPrompt tabId={tabId} {...at("siteButton", BLOCKED_POPUPS_WIDTH)} />}
      {popovers && sitePanels(tabId, panel, (panelWidth) => at("siteButton", panelWidth))}
      {has("sharePicker") && <SharePicker tabId={tabId} paneWidth={width} />}
      {!newTabShown && has("deviceChooser") && <DeviceChooser tabId={tabId} {...at("prompt", DEVICE_CHOOSER_WIDTH)} />}
      {has("castPicker") && <CastPicker tabId={tabId} paneWidth={width} />}
      <SwipeOverlay tabId={tabId} />
      {popovers && has("historyMenu") && <HistoryPopover tabId={tabId} windowId={windowId} top={POPOVER_MARGIN} left={historyMenuAt(anchor, width)} />}
      {has("selection") && <SelectionPopover tabId={tabId} />}
    </>
  );
}

function usePageOverlays(tabId: string, windowId: string, historyMenuShown: boolean): number {
  const page = usePage(tabId, pageOverlays);
  const find = useFindOpen(tabId);
  const control = useControlIndicator((s) => s.shown);
  const newTabNotice = useNewTabNotices((s) => s.notices[windowId]?.sourceId === tabId);
  const engineOffer = useEngineOffers((offers) => !!offers[tabId]);
  const sharePicker = useMedia((m) => !!m.displayRequests[tabId]);
  const deviceChooser = useDeviceChooserOpen(tabId);
  const castPicker = useCast((c) => !!c.dialogs[tabId]);
  const historyMenu = useHistoryMenu((s) => historyMenuShown && s.menu?.tabId === tabId);
  const selection = usePageSelection((s) => !!s[tabId]);
  return page | overlayBits({ find, control, newTabNotice, engineOffer, sharePicker, deviceChooser, castPicker, historyMenu, selection });
}

const historyMenuAt = (anchor: PageAnchor, paneWidth: number) => (direction: -1 | 1) =>
  historyMenuLeft(anchor, underButton(direction < 0 ? anchor.toolbar?.back ?? 0 : anchor.toolbar?.forward ?? 0), paneWidth, HISTORY_MENU_WIDTH);

const SITE_PANELS = ["siteControls", "zoom", "hiddenElements"] as const;

function sitePanels(tabId: string, panel: (kind: (typeof SITE_PANELS)[number]) => PanelPresence | null, place: (panelWidth: number) => { left: number; top: number }) {
  const siteControls = panel("siteControls");
  const zoom = panel("zoom");
  const hiddenElements = panel("hiddenElements");
  return (
    <>
      {siteControls && <SiteControlsPanel tabId={tabId} {...place(SITE_PANEL.width)} {...siteControls} />}
      {zoom && <ZoomPanel tabId={tabId} {...place(ZOOM_POPOVER_WIDTH)} {...zoom} />}
      {hiddenElements && <HiddenElementsPanel tabId={tabId} {...place(HIDDEN_ELEMENTS_WIDTH)} {...hiddenElements} />}
    </>
  );
}

export function BesidePeekPopovers({ tabId, windowId, left, top, room }: { tabId: string; windowId: string; left: number; top: number; room: number }) {
  const popover = usePages((s) => s.popover[tabId] ?? null);
  const panel = usePanelsPresence(popover, SITE_PANELS);
  const fit = (width: number) => ({ left: fitLeft(left, room, width), top });
  return (
    <>
      <BlockedPopupsPrompt tabId={tabId} {...fit(BLOCKED_POPUPS_WIDTH)} />
      {sitePanels(tabId, panel, fit)}
      <HistoryPopover tabId={tabId} windowId={windowId} top={top} left={() => fitLeft(left, room, HISTORY_MENU_WIDTH)} />
    </>
  );
}

export function PeekPage({ tabId, sourceId, windowId, width, shown, fullscreen }: { tabId: string; sourceId: string; windowId: string; width: number; shown: boolean; fullscreen: boolean }) {
  return (
    <>
      <TabWebView tabId={tabId} visible={shown} warm={false} peekOf={sourceId} />
      {shown && <PageOverlays tabId={tabId} windowId={windowId} width={width} geometry={NO_TOOLBAR} toolbar={false} newTabShown={false} cliPill loadingPill={fullscreen} />}
    </>
  );
}
