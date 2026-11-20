import type { ReactElement } from "react";
import type { GestureResponderEvent } from "react-native";
import { closeFrontTab, menuOpenedHaptic, recentTabs, switchToTab, tabTitle } from "../../state/browse/tabMenus";
import type { BrowserTab } from "../../state/tabs/tabModels";
import type { MenuItem } from "../ui";
import { MenuTrigger, nativeMenus } from "../ui/MenuTrigger";

export function tabsMenuItems(order: readonly BrowserTab[]): MenuItem[] {
  const others = recentTabs(order).map((tab): MenuItem => ({ label: tabTitle(tab), onPress: () => switchToTab(tab.id) }));
  return [...others, ...(others.length ? ["divider" as const] : []), { label: "Close Tab", icon: "xmark", systemImage: "xmark", destructive: true, onPress: closeFrontTab }];
}

export type TabsMenuHandlers = { onLongPress?: (event?: GestureResponderEvent) => void; screenReaderActions: { name: string; label: string; run: () => void }[] };

export function TabsMenuTrigger({ order, onTabsMenu, children }: { order: readonly BrowserTab[]; onTabsMenu: () => void; children: (handlers: TabsMenuHandlers) => ReactElement }) {
  if (!nativeMenus())
    return (
      <MenuTrigger testID="tabsButtonMenu" items={tabsMenuItems(order)} trigger="longPress" frost={null} haptic={menuOpenedHaptic}>
        {({ onLongPress }) => children({ onLongPress, screenReaderActions: [] })}
      </MenuTrigger>
    );
  return (
    <MenuTrigger testID="tabsButtonMenu" items={tabsMenuItems(order)} trigger="longPress" frost={null}>
      {() => children({ screenReaderActions: [{ name: "recentTabs", label: "Recent Tabs", run: onTabsMenu }] })}
    </MenuTrigger>
  );
}
