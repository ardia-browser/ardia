import { useEffect } from "react";
import { Animated, StyleSheet, type ViewStyle } from "react-native";
import { ENGINE_OFFER_WIDTH, EngineOfferPrompt } from "../site/EnginePrompt";
import { useTabValue } from "../../state/tabs/tabWatch";
import { ControlPill } from "./ControlPill";
import { LoadingPill } from "./LoadingPill";
import { NewTabNotice } from "./NewTabNotice";
import { FindBar } from "../find/FindBar";
import { POPOVER_MARGIN, usePanelsPresence, type PanelPresence } from "../ui";
import { NO_TOOLBAR, type ToolbarGeometry } from "./geometry";
import { usePages } from "../../state/tabs/pageState";
import { PLUGIN_CHROME, usePluginChrome } from "../../state/plugins/chrome";
import { startPopoverEscape } from "../../state/tabs/popoverDismiss";
import { SadTab, StatusBubble } from "./PaneOverlays";
import { AutofillPrompt, BLOCKED_POPUPS_WIDTH, BlockedPopupsPrompt, EXTERNAL_APP_WIDTH, ExternalAppPrompt, PasswordPrompt, PERMISSION_PROMPT_WIDTH, PermissionPrompt, VerificationCodeOffer } from "../site/Prompts";
import { SiteControlsPanel } from "../site/SiteControls";
import { SITE_PANEL } from "../site/SiteControlsParts";
import { ZOOM_POPOVER_WIDTH, ZoomPanel } from "../site/ZoomControls";
import { HIDDEN_ELEMENTS_WIDTH, HiddenElementsPanel } from "../site/HiddenElements";
import { SelectionPopover } from "../site/SelectionPopover";
import { SharePicker } from "../media/SharePicker";
import { CastPicker } from "../media/CastPicker";
import { DEVICE_CHOOSER_WIDTH, DeviceChooser } from "../site/DeviceChooser";
import { NavigationOverlays } from "./SwipeOverlay";
import { HISTORY_MENU_WIDTH, HistoryPopover } from "./HistoryPopover";
import { TabWebView } from "./TabWebView";
import { fitLeft, pageSurfaceLeft, type PageAnchor, type PageSurface } from "./pageAnchors";
import { useSidebarSide } from "../../state/browser/hooks";

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
  const verificationCodes = usePluginChrome(PLUGIN_CHROME.verificationCodes);
  const zoom = useTabValue(tabId, (t) => t?.zoom ?? 1);
  const sidebarRight = useSidebarSide(windowId) === "right";
  const anchor: PageAnchor = { toolbar: toolbar ? geometry : null, sidebarRight };
  const at = (surface: PageSurface, surfaceWidth: number) => ({ left: pageSurfaceLeft(anchor, surface, width, surfaceWidth), top: POPOVER_MARGIN });
  useEffect(startPopoverEscape, []);
  return (
    <>
      <FindBar tabId={tabId} />
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, statusStyle]}>
        <StatusBubble tabId={tabId} maxWidth={Math.max(160, width / 2)} />
      </Animated.View>
      <SadTab tabId={tabId} />
      {!newTabShown && loadingPill && <LoadingPill tabId={tabId} />}
      {cliPill && <ControlPill style={statusStyle} />}
      {!newTabShown && <PermissionPrompt tabId={tabId} {...at("prompt", PERMISSION_PROMPT_WIDTH)} />}
      <PasswordPrompt tabId={tabId} right={POPOVER_MARGIN} top={POPOVER_MARGIN} />
      <AutofillPrompt tabId={tabId} right={POPOVER_MARGIN} top={POPOVER_MARGIN} />
      {verificationCodes && <VerificationCodeOffer tabId={tabId} right={POPOVER_MARGIN} top={POPOVER_MARGIN} />}
      <NewTabNotice windowId={windowId} tabId={tabId} right={POPOVER_MARGIN} top={POPOVER_MARGIN} />
      {!newTabShown && <ExternalAppPrompt tabId={tabId} {...at("prompt", EXTERNAL_APP_WIDTH)} />}
      {!newTabShown && <EngineOfferPrompt tabId={tabId} {...at("prompt", ENGINE_OFFER_WIDTH)} />}
      {popovers && popover === "popups" && <BlockedPopupsPrompt tabId={tabId} {...at("siteButton", BLOCKED_POPUPS_WIDTH)} />}
      {popovers && sitePanels(tabId, panel, (panelWidth) => at("siteButton", panelWidth))}
      <SharePicker tabId={tabId} paneWidth={width} />
      {!newTabShown && <DeviceChooser tabId={tabId} {...at("prompt", DEVICE_CHOOSER_WIDTH)} />}
      <CastPicker tabId={tabId} paneWidth={width} />
      <NavigationOverlays tabId={tabId} windowId={windowId} anchor={anchor} paneWidth={width} historyMenu={popovers} />
      <SelectionPopover tabId={tabId} zoom={zoom} />
    </>
  );
}

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
      {popover === "popups" && <BlockedPopupsPrompt tabId={tabId} {...fit(BLOCKED_POPUPS_WIDTH)} />}
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
