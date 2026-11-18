import { type ReactNode, useRef } from "react";
import { Pressable, type Insets, type StyleProp, type ViewStyle } from "react-native";
import { hostOf } from "@ardia/core";
import { useSettings } from "../../state/browser/hooks";
import { tabTitle } from "../../state/browser/model";
import type { Tab } from "../../state/browser/types";
import { middleClickTab } from "../../state/sidebar/clearTabs";
import { dismissHover } from "../../state/sidebar/hover";
import { openTabMenu } from "../../state/sidebar/menus";
import { clickHeldTabPress, holdTabPress, pressOutTabPress, type TabPress } from "../../state/sidebar/heldTabPress";
import { tabPressTag } from "../../state/tabs/tabReveal";
import { useSplitOf } from "../../state/windows/card";
import { ContextMenuArea } from "../ui";

export function TabPressArea({
  windowId,
  tab,
  style,
  pressStyle,
  tooltip,
  hitSlop,
  selected = false,
  children,
}: {
  windowId: string;
  tab: Tab;
  style?: StyleProp<ViewStyle>;
  pressStyle?: StyleProp<ViewStyle>;
  tooltip?: string;
  hitSlop?: Insets;
  selected?: boolean;
  children: ReactNode | ((state: { pressed: boolean }) => ReactNode);
}) {
  const press = useRef<TabPress | null>(null);
  const inSplit = !!useSplitOf(tab.id);
  const plainTooltip = useSettings((s) => !s.showTabHoverMenu);
  return (
    <ContextMenuArea
      onMiddleClick={() => middleClickTab(tab.id)}
      onContextMenu={() => {
        dismissHover();
        void openTabMenu(windowId, tab);
      }}
      style={style}
    >
      <Pressable
        onPressIn={(e) => {
          press.current = holdTabPress(windowId, tab.id, e, press.current);
        }}
        onPress={(e) => clickHeldTabPress(windowId, tab.id, e, press.current)}
        onPressOut={(e) => pressOutTabPress(press.current, e)}
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
