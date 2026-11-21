import type { ComponentProps, ReactNode } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { Pressable } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import { withAlpha } from "../../lib/color";
import type { MaterialScheme } from "../../lib/material/schemes";
import { haptics } from "../../state/app/haptics";
import { newTab, openArchive } from "../../state/browse/store";
import { menuOpenedHaptic } from "../../state/browse/tabMenus";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { countUsage } from "../../state/telemetry/telemetry";
import { barAddress, spokenAddress } from "../browsing/FloatingBar";
import { NotSecureLock } from "../browsing/NotSecureLock";
import { TabsMenuTrigger } from "../browsing/tabsMenu";
import { plusMenuItems } from "../tabs/ChromeButtons";
import type { SearchTabs } from "../tabs/DeckBottomBar";
import { MATERIAL_DECK } from "../tabs/MaterialDeckLayout";
import { Favicon, screenReaderActions, Symbol, type SymbolName } from "./index";
import { MaterialIconButton } from "./MaterialIconButton";
import { MenuTrigger } from "./MenuTrigger";
import { useMaterialRipple } from "./MaterialSurfaces";
import { materialBottomBar, materialShape, materialSize, materialType } from "./materialTokens";

export type MaterialPageBarProps = {
  tab: BrowserTab;
  order: BrowserTab[];
  showsPlus: boolean;
  addressDocked?: boolean;
  onTabs: () => void;
  onTabsMenu: () => void;
  onStep: (delta: -1 | 1) => void;
  onAddress: () => void;
  onPlus: () => void;
  onMore: () => void;
  onSiteSettings: () => void;
};

type OverviewProps = {
  search: SearchTabs;
  incognito: boolean;
  canReopen: boolean;
  menusShown: boolean;
  onMenu: (open: boolean) => void;
};

export type MaterialStartBarProps = {
  incognito: boolean;
  onSearch: () => void;
};

export type MaterialBottomBarProps = { scheme: MaterialScheme; container?: ComponentProps<typeof Animated.View> } & (
  | ({ isTabOverview: false; isStart?: false } & MaterialPageBarProps)
  | ({ isTabOverview: true; isStart?: false } & OverviewProps)
  | ({ isStart: true; isTabOverview?: false } & MaterialStartBarProps)
);

const TAB_COUNT_BOX = 20;
const FIELD_ICON = 20;
const MAX_COUNT = 99;

export const tabCountLabel = (count: number) => (count > MAX_COUNT ? `${MAX_COUNT}+` : String(count));

export function MaterialBottomBar(props: MaterialBottomBarProps) {
  const { scheme, container } = props;
  return (
    <MaterialBottomBarSurface scheme={scheme} container={container}>
      {props.isStart ? <StartControls {...props} /> : props.isTabOverview ? <OverviewControls {...props} /> : <PageControls {...props} />}
    </MaterialBottomBarSurface>
  );
}

export function MaterialBottomBarSurface({ scheme, container, children }: { scheme: MaterialScheme; container?: ComponentProps<typeof Animated.View>; children: ReactNode }) {
  return (
    <Animated.View {...container} style={[styles.row, { backgroundColor: scheme.surfaceContainer }, container?.style]}>
      {children}
    </Animated.View>
  );
}

function PageControls({ scheme, tab, order, showsPlus, addressDocked, onTabs, onTabsMenu, onStep, onAddress, onPlus, onMore, onSiteSettings }: MaterialPageBarProps & { scheme: MaterialScheme }) {
  const field = useMaterialRipple();
  const address = barAddress(tab);
  const count = order.length;
  return (
    <>
      <TabsMenuTrigger order={order} onTabsMenu={onTabsMenu} style={styles.iconSlot}>
        {({ onLongPress, screenReaderActions: menuActions }) => (
          <MaterialIconButton
            testID="materialBarTabs"
            label="Tabs"
            value={{ text: `${count} ${count === 1 ? "tab" : "tabs"}` }}
            hint="Touch and hold for recent tabs."
            scheme={scheme}
            {...screenReaderActions([
              { name: "activate", run: onTabs },
              ...menuActions,
              { name: "previousTab", label: "Previous Tab", run: () => onStep(-1) },
              { name: "nextTab", label: "Next Tab", run: () => onStep(1) },
            ])}
            onPress={onTabs}
            onLongPress={onLongPress ? () => onLongPress() : undefined}
          >
            <View testID="materialTabCount" style={[styles.countBox, { borderColor: scheme.onSurfaceVariant }]}>
              <Text style={[materialType.labelSmall, styles.count, { color: scheme.onSurfaceVariant }]}>{tabCountLabel(count)}</Text>
            </View>
          </MaterialIconButton>
        )}
      </TabsMenuTrigger>
      <View style={styles.fieldContainer}>
        <Pressable
          testID="materialAddressField"
          accessibilityRole="button"
          accessibilityLabel="Address"
          accessibilityValue={{ text: spokenAddress(address) }}
          accessibilityHint="Opens search with this page’s address. Touch and hold for the page menu."
          {...screenReaderActions([{ name: "activate", run: onAddress }, { name: "pageMenu", label: "Page Menu", run: onMore }])}
          android_ripple={field}
          onPress={onAddress}
          onLongPress={onMore}
          style={[styles.fieldContainer, styles.fieldPressable, { backgroundColor: scheme.surfaceContainerHigh }, addressDocked ? styles.docked : null]}
        >
          <MaterialAddressContent address={address} scheme={scheme} testID="materialBarHost" />
          <MaterialIconButton
            testID="materialBarSiteSettings"
            icon="ellipsis"
            iconSize={FIELD_ICON}
            label="Page Menu"
            scheme={scheme}
            size="compact"
            turned
            onPress={onSiteSettings}
          />
        </Pressable>
      </View>
      {showsPlus ? (
        <MaterialIconButton testID="materialBarPlus" icon="plus" label="New Search" scheme={scheme} onPress={onPlus} />
      ) : null}
    </>
  );
}

export function MaterialAddressContent({ address, scheme, testID }: { address: ReturnType<typeof barAddress>; scheme: MaterialScheme; testID: string }) {
  return (
    <>
      {address.isPrivate ? (
        <Symbol name="eyeglassesThin" size={materialSize.icon} color={scheme.onSurfaceVariant} />
      ) : address.insecure ? (
        <NotSecureLock testID="materialBarNotSecure" size={FIELD_ICON} color={scheme.error} />
      ) : address.pageUrl ? (
        <Favicon iconUrl={address.iconUrl} pageUrl={address.pageUrl} size={FIELD_ICON} />
      ) : (
        <Symbol name="magnifyingglass" size={materialSize.icon} color={scheme.onSurfaceVariant} />
      )}
      <Text testID={testID} numberOfLines={1} ellipsizeMode="tail" style={[materialType.bodyLarge, styles.host, { color: scheme.onSurface }]}>
        {address.host}
      </Text>
    </>
  );
}

function OverviewControls({ scheme, search, incognito, canReopen, menusShown, onMenu }: OverviewProps & { scheme: MaterialScheme }) {
  const { input, text, change, focus, blur } = search;
  const fabLabel = incognito ? "New Incognito Tab" : "New Tab";
  const showArchive = () => {
    if (!incognito) countUsage("archive_bar_opened");
    openArchive();
  };
  return (
    <>
      <MaterialBarIconButton testID="materialDeckArchive" icon="archivebox" label="Archive Tabs" scheme={scheme} onPress={showArchive} />
      <Pressable accessible={false} onPress={() => input.current?.focus()} style={[styles.fieldContainer, styles.fieldPressable, { backgroundColor: scheme.surfaceContainerHigh }]} testID="materialDeckSearch">
        <View pointerEvents="none">
          <Symbol name="magnifyingglass" size={materialSize.icon} color={scheme.onSurfaceVariant} />
        </View>
        <TextInput
          ref={input}
          testID="deckSearchField"
          accessibilityLabel="Search Tabs"
          placeholder="Search Tabs"
          placeholderTextColor={scheme.onSurfaceVariant}
          cursorColor={scheme.secondary}
          selectionColor={withAlpha(scheme.secondary, 0.4)}
          value={text}
          onChangeText={change}
          onFocus={focus}
          onBlur={blur}
          onSubmitEditing={() => input.current?.blur()}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={[materialType.bodyLarge, styles.field, { color: scheme.onSurface }]}
        />
        {text ? <MaterialBarIconButton testID="materialDeckSearchClear" icon="xmark" label="Clear Search" scheme={scheme} onPress={() => change("")} /> : null}
      </Pressable>
      <MenuTrigger
        items={plusMenuItems(incognito, canReopen)}
        trigger="longPress"
        frost={null}
        haptic={menuOpenedHaptic}
        disabled={!menusShown}
        onOpen={() => onMenu(true)}
        onClose={() => onMenu(false)}
        place={{ bottom: materialBottomBar.field + MATERIAL_DECK.keyboardGap, right: 0 }}
        style={styles.fabSlot}
      >
        {({ onLongPress }) => (
          <MaterialIconButton
            testID="materialDeckFab"
            icon="plus"
            label={fabLabel}
            hint="Touch and hold for more options."
            scheme={scheme}
            onPressIn={haptics.barPress}
            onPress={newTab}
            onLongPress={onLongPress ? () => onLongPress() : undefined}
          />
        )}
      </MenuTrigger>
    </>
  );
}

function StartControls({ scheme, incognito, onSearch }: MaterialStartBarProps & { scheme: MaterialScheme }) {
  const field = useMaterialRipple();
  return (
    <View style={styles.fieldContainer}>
      <Pressable
        testID="materialStartSearch"
        accessibilityRole="button"
        accessibilityLabel={incognito ? "New Incognito Tab" : "New Tab"}
        accessibilityHint="Opens search."
        android_ripple={field}
        onPress={onSearch}
        style={[styles.fieldContainer, styles.fieldPressable, styles.startField, { backgroundColor: scheme.surfaceContainerHigh }]}
      >
        <Symbol name="magnifyingglass" size={materialSize.icon} color={scheme.onSurfaceVariant} />
        <Text numberOfLines={1} style={[materialType.bodyLarge, styles.host, { color: scheme.onSurfaceVariant }]}>
          Search or type address
        </Text>
      </Pressable>
    </View>
  );
}

export function MaterialBarIconButton({ testID, icon, label, hint, scheme, turned = false, onPress }: { testID: string; icon: SymbolName; label: string; hint?: string; scheme: MaterialScheme; turned?: boolean; onPress: () => void }) {
  return <MaterialIconButton testID={testID} icon={icon} label={label} hint={hint} scheme={scheme} turned={turned} onPressIn={haptics.barPress} onPress={onPress} />;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: materialBottomBar.gap, paddingHorizontal: materialBottomBar.pad, height: materialBottomBar.height, borderRadius: materialShape.full, elevation: 3 },
  fieldContainer: { flex: 1, height: materialBottomBar.field, borderRadius: materialShape.full, overflow: "hidden" },
  fieldPressable: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 12, paddingRight: 4 },
  startField: { paddingRight: 16 },
  field: { flex: 1, paddingVertical: 0, includeFontPadding: false },
  fabSlot: { width: materialBottomBar.field, height: materialBottomBar.field },
  host: { flex: 1 },
  docked: { opacity: 0 },
  iconSlot: { width: materialSize.touchTarget, height: materialSize.touchTarget },
  countBox: { minWidth: TAB_COUNT_BOX, height: TAB_COUNT_BOX, borderWidth: 2, borderRadius: materialShape.extraSmall, alignItems: "center", justifyContent: "center", paddingHorizontal: 2 },
  count: { textAlign: "center" },
});
