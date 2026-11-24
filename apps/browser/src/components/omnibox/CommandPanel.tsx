import { OutsidePressArea } from "../ui";
import { useEffect } from "react";
import { StyleSheet } from "react-native";
import { hex, useTheme } from "../ui/theme";
import { useSidebarSide, useWindowId, useWindowUi } from "../../state/browser/hooks";
import { useActiveTabIdWhile } from "../../state/omnibox/hooks";
import { centredBarLeft, isCentred } from "../../state/omnibox/barPlacement";
import { usePage } from "../../state/tabs/pageState";
import { dismissHover, holdRowsCovered, panelCoversRows } from "../../state/sidebar/hover";
import { useAddressBarInSidebar, useCardAnchors, useUrlAnchors, useWindowControlsBottom } from "../../state/windows/layout";
import { useSidebarField } from "../../state/sidebar/chrome";
import { barWidth } from "../ntp/NewTabPage";
import { closeNewTabBar } from "../../state/omnibox/newTabBar";
import type { NewTabTarget } from "../../state/browser/types";
import { Omnibox } from "./Omnibox";
import { PanelBox } from "./PanelBox";
import { BAR, PANEL_TEXT_LEFT } from "./tokens";
import { cancelPanel, closePanelToHeroBar, type BarDismissal } from "../../state/omnibox/barState";
import { closeBlankLittleArdiaOnEscape } from "../../state/littleArdia/actions";
import { insecureLevel, urlTextLeft } from "../toolbar/Toolbar";
import { useToolbarRow } from "../toolbar/useToolbarRow";
import { compactLift } from "../../lib/toolbarRow";
import { radius, shadow, space } from "../ui/tokens";
import { trailingClearance } from "../../lib/windowChrome";

const RIGHT_OF_URL = 40;
const ABOVE_PANE = 5.5;
const MIN_WIDTH = 420;
const WINDOW_MARGIN = space.l;
const DROPDOWN_MIN_WIDTH = 350;
const DROPDOWN_PAST_FIELD = 137;
const CENTRED_TOP_SHARE = 0.22;

type Box = { left: number; top: number; width: number; height: number };

export function CommandPanel({ windowWidth }: { windowWidth: number }) {
  const theme = useTheme();
  const windowId = useWindowId();
  const { panel } = useWindowUi();
  const activeId = useActiveTabIdWhile(windowId, panel.open);
  const insecure = usePage(activeId, (p) => !!insecureLevel(p));
  const anchor = useUrlAnchors((s) => (panel.open ? s[windowId] : undefined));
  const sidebarField = useSidebarField();
  const fieldAway = useAddressBarInSidebar() && sidebarField !== "top";
  const centred = panel.open && !panel.newTab && (isCentred(panel.placement) || fieldAway);
  const card = useCardAnchors((s) => (panel.newTab || centred ? s[windowId] : undefined));
  const toolbarRow = useToolbarRow();
  const controlsBottom = useWindowControlsBottom();
  const sidebarRight = useSidebarSide(windowId) === "right";
  const overRows = panelCoversRows({ open: panel.open, newTab: !!panel.newTab, centred: centred && !!card, hasActiveTab: !!activeId, sidebarAnchor: !!anchor?.sidebar });
  useEffect(() => {
    if (panel.open) dismissHover();
  }, [panel.open, overRows, windowId]);
  useEffect(() => holdRowsCovered(windowId, overRows), [overRows, windowId]);
  if (!panel.open || !activeId) return null;
  if (panel.newTab) return card ? <CentredBar windowId={windowId} tabId={activeId} target={panel.newTab} frame={centredFrame(card, windowWidth)} /> : null;

  const room = (left: number, top: number, fallback: number) => (windowWidth > 0 ? windowWidth - left - trailingClearance(top, WINDOW_MARGIN, controlsBottom) : fallback);
  const onCancel = () => cancelPanel(windowId);
  const onDone = (reason?: BarDismissal) => {
    if (reason !== "escape" || !closeBlankLittleArdiaOnEscape(windowId)) closePanelToHeroBar(windowId, activeId, reason);
  };
  const surface = (radius: number) => panelSurface(theme, radius);

  if (centred && card) {
    return (
      <PanelBox frame={centredFrame(card, windowWidth)} surface={surface(radius.hero)}>
        <OutsidePressArea onOutsidePress={onCancel}>
          <Omnibox key={activeId} variant="panel" floating tabId={activeId} initialText={panel.initialText} onCancel={onCancel} onDone={onDone} />
        </OutsidePressArea>
      </PanelBox>
    );
  }
  if (!anchor) return null;

  if (anchor.sidebar) {
    const shown = anchor.left >= 0 && (!sidebarRight || windowWidth <= 0 || anchor.left < windowWidth);
    const wanted = Math.max(DROPDOWN_MIN_WIDTH, anchor.width + DROPDOWN_PAST_FIELD);
    const end = shown ? anchor.left + anchor.width : windowWidth - WINDOW_MARGIN;
    const left = sidebarRight ? Math.max(WINDOW_MARGIN, end - wanted) : shown ? anchor.left : WINDOW_MARGIN;
    const width = sidebarRight ? end - left : Math.min(wanted, room(left, anchor.top, DROPDOWN_MIN_WIDTH));
    return (
      <PanelBox frame={{ left, top: anchor.top, width }} surface={surface(radius.panel)} clipRadius={radius.panel}>
        <OutsidePressArea onOutsidePress={onCancel}>
          <Omnibox key={activeId} variant="sidebar" tabId={activeId} initialText={panel.initialText} onCancel={onCancel} onDone={onDone} />
        </OutsidePressArea>
      </PanelBox>
    );
  }

  const left = Math.max(WINDOW_MARGIN, anchor.left + urlTextLeft(insecure) - PANEL_TEXT_LEFT);
  const top = Math.max(0.5, anchor.top - ABOVE_PANE);
  const covering = anchor.left + anchor.width + RIGHT_OF_URL - left;
  const width = Math.min(Math.max(covering, MIN_WIDTH), room(left, top, covering));
  const lift = compactLift(toolbarRow);
  return (
    <PanelBox frame={{ left, top, width }} surface={surface(radius.hero)} clipRadius={radius.hero}>
      <OutsidePressArea onOutsidePress={onCancel}>
        <Omnibox key={activeId} variant="panel" tabId={activeId} initialText={panel.initialText} fieldRowHeight={BAR.panel.height - 2 * lift} onCancel={onCancel} onDone={onDone} />
      </OutsidePressArea>
    </PanelBox>
  );
}

function panelSurface(theme: ReturnType<typeof useTheme>, radius: number) {
  return {
    fill: hex(theme.ntpBarSolid),
    cornerRadius: radius,
    borderColor: hex(theme.ntpBarBorder),
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: shadow.dialog.color,
    shadowOpacity: theme.panelShadowOpacity,
    shadowRadius: shadow.dialog.radius,
    shadowOffset: shadow.dialog.offset,
  };
}

function centredFrame(card: Box, windowWidth: number) {
  const width = barWidth(card.width);
  const left = centredBarLeft(card, width, windowWidth);
  const top = card.top + Math.max(WINDOW_MARGIN, Math.round(card.height * CENTRED_TOP_SHARE));
  return { left, top, width };
}

function CentredBar({ windowId, tabId, target, frame }: { windowId: string; tabId: string; target: NewTabTarget; frame: { left: number; top: number; width: number } }) {
  const theme = useTheme();
  const onCancel = () => cancelPanel(windowId);
  const onDone = () => closeNewTabBar(windowId);
  return (
    <PanelBox frame={frame} surface={panelSurface(theme, radius.hero)}>
      <OutsidePressArea onOutsidePress={onCancel}>
        <Omnibox key={`newTab:${target.kind}`} variant="panel" floating tabId={tabId} opensTab={target} onCancel={onCancel} onDone={onDone} />
      </OutsidePressArea>
    </PanelBox>
  );
}
