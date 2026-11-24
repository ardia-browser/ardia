import { haptics } from "../../state/app/haptics";
import { TabsMenuTrigger } from "./tabsMenu";
import { useRef } from "react";
import { StyleSheet, View, type ViewInstance } from "react-native";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { display } from "../../state/search/omnibox";
import { BarPlusGlyph, browseLayout, capsule, PressInPlace, shadowRadius, Symbol, TabFace, tabsInk, tabsLayout, type ColorRoles } from "../ui";
import { newTabLabel } from "./barWords";
import { openPageMenuFrom } from "./pageMenuOpener";

type Props = {
  order: BrowserTab[];
  roles: ColorRoles;
  showsPlus: boolean;
  incognito?: boolean;
  onTabs: () => void;
  onTabsMenu: () => void;
  onStep: (delta: -1 | 1) => void;
  onPlus: () => void;
  onMore: () => void;
};

export function BottomBar({ order, roles, showsPlus, incognito = false, onTabs, onTabsMenu, onStep, onPlus, onMore }: Props) {
  const plus = browseLayout.plusCapsule;
  const count = order.length;
  const menuButton = useRef<ViewInstance>(null);
  return (
    <View style={styles.row}>
      <View style={styles.side}>
        <TabsMenuTrigger order={order} onTabsMenu={onTabsMenu}>
          {({ onLongPress, screenReaderActions }) => (
            <PressInPlace
              label="Tabs"
              value={`${count} ${count === 1 ? "tab" : "tabs"}`}
              hint="Touch and hold for recent tabs."
              longPressLabel="Recent Tabs"
              actions={[
                ...screenReaderActions,
                { name: "previousTab", label: "Previous Tab", run: () => onStep(-1) },
                { name: "nextTab", label: "Next Tab", run: () => onStep(1) },
              ]}
              onPress={onTabs}
              onPressIn={haptics.barPress}
              onLongPress={onLongPress}
              style={styles.tabs}
            >
              <TabStack tabs={order.slice(-2)} roles={roles} />
            </PressInPlace>
          )}
        </TabsMenuTrigger>
      </View>
      <View style={{ width: plus.width, height: plus.height }}>
        {showsPlus ? (
          <PressInPlace
            label={newTabLabel(incognito)}
            onPress={onPlus}
            onPressIn={haptics.barPress}
            style={[
              styles.center,
              { width: plus.width, height: plus.height, borderRadius: capsule(plus.height), backgroundColor: roles.plusFill, borderColor: roles.controlEdge },
            ]}
          >
            <BarPlusGlyph color={roles.foregroundPrimary} />
          </PressInPlace>
        ) : null}
      </View>
      <View style={[styles.side, styles.end]}>
        <PressInPlace ref={menuButton} label="Page Menu" onPress={() => openPageMenuFrom(() => menuButton.current, onMore)} onPressIn={haptics.barPress} style={styles.more}>
          <View
            style={[
              styles.center,
              styles.chevron,
              { backgroundColor: roles.chevronFill, borderColor: roles.controlEdge, borderRadius: capsule(browseLayout.chevronCircle) },
            ]}
          >
            <Symbol name="chevronUp" size={browseLayout.chevronGlyph} color={roles.foregroundPrimary} />
          </View>
        </PressInPlace>
      </View>
    </View>
  );
}

export function TabStack({ tabs, roles }: { tabs: BrowserTab[]; roles: ColorRoles }) {
  const tile = tabsLayout.tabStackTile;
  if (!tabs.length) {
    return <View style={[styles.tile, { width: tile.width, height: tile.height, borderColor: roles.foregroundSecondary, borderWidth: 1.5 }]} />;
  }
  if (tabs.length === 1) {
    return (
      <View testID="tabStack" style={{ width: tile.width, height: tile.height }}>
        <Thumbnail tab={tabs[0]!} roles={roles} turn="-4deg" x={0} y={0} />
      </View>
    );
  }
  return (
    <View testID="tabStack" style={{ width: tile.width, height: tile.height }}>
      <Thumbnail tab={tabs[0]!} roles={roles} turn="-12deg" x={-4} y={1} />
      <Thumbnail tab={tabs[1]!} roles={roles} turn="6deg" x={4} y={-1} />
    </View>
  );
}

function Thumbnail({ tab, roles, turn, x, y }: { tab: BrowserTab; roles: ColorRoles; turn: string; x: number; y: number }) {
  const tile = tabsLayout.tabStackTile;
  const shown = display(tab.url);
  return (
    <View
      testID="tabStackCard"
      style={[
        styles.tile,
        styles.thumbnail,
        {
          width: tile.width,
          height: tile.height,
          borderColor: roles.tileEdge,
          shadowColor: tabsInk.tileShadow,
          transform: [{ translateX: x }, { translateY: y }, { rotate: turn }],
        },
      ]}
    >
      <TabFace tab={tab} title={tab.title} host={shown.host} tone={roles.tileFill} roles={roles} compact />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    height: browseLayout.hitTarget,
    paddingHorizontal: browseLayout.barSideInset - 4,
  },
  side: { flex: 1, alignItems: "flex-start", justifyContent: "center" },
  end: { alignItems: "flex-end" },
  tabs: { width: tabsLayout.tabStackButton, height: browseLayout.hitTarget, alignItems: "center", justifyContent: "center", left: -2.8 },
  center: { alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth },
  more: { width: browseLayout.hitTarget, height: browseLayout.hitTarget, alignItems: "center", justifyContent: "center" },
  chevron: { width: browseLayout.chevronCircle, height: browseLayout.chevronCircle },
  tile: { borderRadius: tabsLayout.tabStackRadius },
  thumbnail: { position: "absolute", overflow: "hidden", borderWidth: 0.5, elevation: 2, shadowOpacity: 1, shadowRadius: shadowRadius.tile },
});
