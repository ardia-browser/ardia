import { type ReactNode, useRef } from "react";
import { Pressable, type Insets, type StyleProp, type ViewStyle } from "react-native";
import { hostOf } from "@ardia/core";
import { useSettings } from "../../state/browser/hooks";
import { tabTitle } from "../../state/browser/model";
import type { Tab } from "../../state/browser/types";
import { middleClickTab } from "../../state/sidebar/clearTabs";
import { pressStripClose } from "../../state/tabs/stripPress";
import { workspaceSnapshot } from "../../state/browser/current";
import { dismissHover } from "../../state/sidebar/hover";
import { openTabMenu } from "../../state/sidebar/menus";
import { clickHeldTabPress, endPressGesture, holdTabPress, pressOutTabPress, type TabPress, type TileDoubleClick } from "../../state/sidebar/heldTabPress";
import { tabPressTag } from "../../state/tabs/tabReveal";
import { useInSplit } from "../../state/windows/card";
import { ContextMenuArea } from "../ui";
import { consentToken } from "../../state/telemetry/client";

type TabPressProps = {
  windowId: string;
  tab: Tab;
  style?: StyleProp<ViewStyle>;
  pressStyle?: StyleProp<ViewStyle>;
  tooltip?: string;
  hitSlop?: Insets;
  selected?: boolean;
  onSwitch?: () => void;
  onDoubleClick?: TileDoubleClick;
  children: ReactNode | ((state: { pressed: boolean }) => ReactNode);
};

export function TabPressArea(props: TabPressProps) {
  const press = useRef<TabPress | null>(null);
  const inSplit = useInSplit(props.tab.id);
  const plainTooltip = useSettings((s) => !s.showTabHoverMenu);
  return tabPressView({ ...props, press, inSplit, plainTooltip });
}

export function tabPressView({
  windowId,
  tab,
  style,
  pressStyle,
  tooltip,
  hitSlop,
  selected = false,
  onSwitch,
  onDoubleClick,
  children,
  press,
  inSplit,
  plainTooltip,
  onPressChange,
}: TabPressProps & { press: { current: TabPress | null }; inSplit: boolean; plainTooltip: boolean; onPressChange?: (pressed: boolean) => void }) {
  return (
    <ContextMenuArea
      onMiddleClick={() => {
        const user = { consent: consentToken() };
        pressStripClose(windowId, tab.id, () => middleClickTab(tab.id, user), (tabId) => !!workspaceSnapshot().tabs[tabId]);
      }}
      onContextMenu={() => {
        dismissHover();
        void openTabMenu(windowId, tab);
      }}
      style={style}
    >
      <Pressable
        onPressIn={(e) => {
          onPressChange?.(true);
          const before = press.current;
          press.current = holdTabPress(windowId, tab.id, e, before);
          if (press.current !== before && press.current.switched) onSwitch?.();
        }}
        onPress={(e) => clickHeldTabPress(windowId, tab.id, e, press.current, onDoubleClick)}
        onPressOut={(e) => {
          onPressChange?.(false);
          pressOutTabPress(press.current, e);
        }}
        onTouchEnd={() => endPressGesture(press.current)}
        onTouchCancel={() => endPressGesture(press.current)}
        style={pressStyle}
        nativeID={tabPressTag(tab.id, selected, inSplit)}
        collapsable={false}
        hitSlop={hitSlop}
        tooltip={tooltip ?? (plainTooltip ? titleTooltip(tab) : undefined)}
      >
        {children}
      </Pressable>
    </ContextMenuArea>
  );
}

function titleTooltip(tab: Tab): string {
  const host = tab.url ? hostOf(tab.url) : "";
  return host ? `${tabTitle(tab)}\n${host}` : tabTitle(tab);
}
