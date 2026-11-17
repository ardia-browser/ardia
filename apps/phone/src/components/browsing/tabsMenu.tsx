import type { ReactElement } from "react";
import { closeFrontTab, recentTabs, switchToTab, tabTitle } from "../../state/browse/tabMenus";
import type { BrowserTab } from "../../state/tabs/tabModels";
import type { MenuItem } from "../ui";
import { MenuTrigger, nativeMenus } from "../ui/MenuTrigger";

export function tabsMenuItems(order: readonly BrowserTab[]): MenuItem[] {
  const others = recentTabs(order).map((tab): MenuItem => ({ label: tabTitle(tab), onPress: () => switchToTab(tab.id) }));
  return [...others, ...(others.length ? ["divider" as const] : []), { label: "Close Tab", icon: "xmark", systemImage: "xmark", destructive: true, onPress: closeFrontTab }];
}

export type TabsMenuHandlers = { onLongPress?: () => void; screenReaderActions: { name: string; label: string; run: () => void }[] };

export function TabsMenuTrigger({ order, onTabsMenu, children }: { order: readonly BrowserTab[]; onTabsMenu: () => void; children: (handlers: TabsMenuHandlers) => ReactElement }) {
  if (!nativeMenus()) return children({ onLongPress: onTabsMenu, screenReaderActions: [] });
  return (
    <MenuTrigger testID="tabsButtonMenu" items={tabsMenuItems(order)} trigger="longPress">
      {() => children({ screenReaderActions: [{ name: "recentTabs", label: "Recent Tabs", run: onTabsMenu }] })}
    </MenuTrigger>
  );
}
