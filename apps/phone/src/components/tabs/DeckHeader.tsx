import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { withSpring } from "react-native-reanimated";
import { haptics } from "../../state/app/haptics";
import { newIncognitoTab, openArchive, openSpaces, reopenLastClosed } from "../../state/browse/store";
import { menuOpenedHaptic } from "../../state/browse/tabMenus";
import { openSettings } from "../../state/settings/hooks";
import { selectProfile } from "../../state/sync/actions";
import { useSelectedProfile, useSyncStatus, useSyncView } from "../../state/sync/hooks";
import { useCanReopen, useIncognito } from "../../state/tabs/hooks";
import { countUsage } from "../../state/telemetry/telemetry";
import { browseLayout, capsule, ChromeSurface, deckChromeInk, deckChromeLayout, deckChromeMotion, font, IncognitoSpecs, menuLook, tabsInk, tabsLayout, useTheme, type MenuItem } from "../ui";
import { deckLook } from "./deckLook";
import { MenuTrigger, nativeMenus, spaceSystemImage } from "../ui/MenuTrigger";
import { SpaceTitle, spaceMenuSymbol } from "../search/StartSpaces";
import { FadingGlyphs, GlassCircleButton, type ChromeFade } from "./ChromeButtons";

type Props = {
  safeTop: number;
  safeSide: number;
  sideInset: number;
  privateCount: number;
  hasTabs: boolean;
  onCloseIncognito: () => void;
  onCloseAll: () => void;
  menusShown?: boolean;
  onMenu?: (open: boolean) => void;
} & ChromeFade;

export const deckHeaderBottom = () => deckChromeLayout.headerCenter + deckChromeLayout.headerCircle / 2;

const menuGroupsRuled = () => nativeMenus() || menuLook.dividerLine > 0;

function joinMenuGroups(groups: readonly MenuItem[][], ruled: boolean = menuGroupsRuled()): MenuItem[] {
  return groups.filter((group) => group.length > 0).flatMap((group, index): MenuItem[] => (index > 0 && ruled ? ["divider", ...group] : group));
}

export function deckMoreMenuItems({ syncEnabled, canReopen, hasTabs, onCloseAll, archive = true }: { syncEnabled: boolean; canReopen: boolean; hasTabs: boolean; onCloseAll: () => void; archive?: boolean }): MenuItem[] {
  return joinMenuGroups([
    [...(archive ? [{ label: "Archive", icon: "archivebox" as const, onPress: openArchive }] : []), ...(syncEnabled ? [{ label: "Spaces From Your Mac", icon: "macAndPhone" as const, onPress: openSpaces }] : [])],
    [{ label: "New Incognito Tab", icon: "eyes", onPress: newIncognitoTab }, ...(canReopen ? [{ label: "Reopen Closed Tab", icon: "arrowUturnBackward" as const, onPress: reopenLastClosed }] : []), ...(hasTabs ? [{ label: "Close All Tabs", icon: "xmark" as const, destructive: true, onPress: onCloseAll }] : [])],
    [{ label: "Settings", icon: "gearshape", onPress: () => openSettings() }],
  ]);
}

export function useDeckSpaces() {
  const status = useSyncStatus();
  const view = useSyncView();
  const shown = useSelectedProfile();
  const incognito = useIncognito();
  const spaces = status.isEnabled ? view.profiles : [];
  const current = shown ?? spaces[0] ?? null;
  const choose = (id: string) => {
    if (id === current?.syncId) return;
    haptics.selection();
    if (!incognito) countUsage("spaces_picked");
    selectProfile(id);
  };
  const spaceItems: MenuItem[] = spaces.map((space) => ({ label: space.name, icon: spaceMenuSymbol(space) ?? undefined, systemImage: spaceSystemImage(space.name, space.icon), checked: space.syncId === current?.syncId, onPress: () => choose(space.syncId) }));
  return { syncEnabled: status.isEnabled, spaces, current, spaceItems };
}

export function DeckHeader({ safeTop, safeSide, sideInset, privateCount, hasTabs, onCloseIncognito, onCloseAll, menusShown = true, onMenu, glassShown, glassShownMs, glyphFade }: Props) {
  const theme = useTheme();
  const canReopen = useCanReopen();
  const { syncEnabled, spaces, current, spaceItems } = useDeckSpaces();
  const side = safeSide + sideInset;
  const below = safeTop + deckHeaderBottom() + deckChromeLayout.menuGap;
  const opened = () => onMenu?.(true);
  const closed = () => onMenu?.(false);
  const menu = { trigger: "tap" as const, fixedOrder: true, haptic: menuOpenedHaptic, disabled: !menusShown, onOpen: opened, onClose: closed };
  const moreItems = deckMoreMenuItems({ syncEnabled, canReopen, hasTabs, onCloseAll, archive: false });
  const pillItems: MenuItem[] = [{ label: "Close Incognito Tabs", icon: "xmark", destructive: true, onPress: onCloseIncognito }];
  return (
    <View testID="deckHeader" pointerEvents="box-none" style={[styles.row, { top: safeTop + deckChromeLayout.headerCenter - browseLayout.hitTarget / 2, paddingHorizontal: side }]}>
      {current && spaces.length > 1 ? (
        <MenuTrigger items={spaceItems} {...menu} place={{ top: below, left: side, width: tabsLayout.menuWidth }} style={styles.switcher}>
          {({ onPress }) => (
            <ChromeSurface testID="deckSwitcherGlass" shape="capsule" cornerRadius={deckLook.switcherCorner} dark={theme.dark} shown={glassShown} shownMs={glassShownMs}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Space, ${current.name}`} accessibilityHint="Shows your Mac’s spaces." onPress={onPress} style={styles.switcherPress}>
                <FadingGlyphs testID="deckSwitcher" fade={glyphFade}>
                  <SpaceTitle space={current} dark={theme.dark} showsChevron />
                </FadingGlyphs>
              </Pressable>
            </ChromeSurface>
          )}
        </MenuTrigger>
      ) : (
        <FadingGlyphs testID="deckSwitcher" fade={glyphFade} style={styles.switcher}>
          {current ? (
            <View accessible accessibilityRole="header" accessibilityLabel={current.name}>
              <SpaceTitle space={current} dark={theme.dark} showsChevron={false} />
            </View>
          ) : (
            <Text accessibilityRole="header" numberOfLines={1} style={[font.body, styles.fallback, { color: theme.headerText }]}>
              Tabs
            </Text>
          )}
        </FadingGlyphs>
      )}
      <View style={styles.spacer} />
      {privateCount > 0 && Platform.OS !== "android" ? (
        <Animated.View entering={pillIn} exiting={pillOut}>
          <FadingGlyphs testID="deckIncognitoPillFade" fade={glyphFade}>
            <MenuTrigger items={pillItems} {...menu} place={{ top: below, right: side + deckChromeLayout.headerCircle + deckChromeLayout.headerGap, width: tabsLayout.menuWidth }}>
              {({ onPress }) => <IncognitoPill count={privateCount} onPress={onPress ?? noop} />}
            </MenuTrigger>
          </FadingGlyphs>
        </Animated.View>
      ) : null}
      <MenuTrigger items={moreItems} {...menu} place={{ top: below, right: side, width: tabsLayout.menuWidth }}>
        {({ onPress }) => <GlassCircleButton icon="ellipsis" label="More" testID="deckHeaderMore" diameter={deckChromeLayout.headerCircle} dark={theme.dark} glassShown={glassShown} glassShownMs={glassShownMs} glyphFade={glyphFade} onPress={onPress ?? noop} />}
      </MenuTrigger>
    </View>
  );
}

const noop = () => undefined;

function IncognitoPill({ count, onPress }: { count: number; onPress: () => void }) {
  return (
    <Pressable
      testID="deckIncognitoPill"
      accessibilityRole="button"
      accessibilityLabel={`Incognito, ${count} ${count === 1 ? "tab" : "tabs"}`}
      accessibilityHint="Shows the option to close incognito tabs."
      onPress={onPress}
      style={styles.pillHit}
    >
      <View pointerEvents="none" style={[styles.pill, { backgroundColor: tabsInk.incognitoOnLight, borderRadius: capsule(deckChromeLayout.pillHeight) }]}>
        <IncognitoSpecs size={deckChromeLayout.pillSpecs} color={deckChromeInk.pill} />
        <Text style={[font.subheadline, styles.count]}>{count}</Text>
      </View>
    </Pressable>
  );
}

const pillIn = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: deckChromeMotion.pillScale }] },
    animations: { opacity: withSpring(1, deckChromeMotion.pill), transform: [{ scale: withSpring(1, deckChromeMotion.pill) }] },
  };
};

const pillOut = () => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ scale: 1 }] },
    animations: { opacity: withSpring(0, deckChromeMotion.pill), transform: [{ scale: withSpring(deckChromeMotion.pillScale, deckChromeMotion.pill) }] },
  };
};

const styles = StyleSheet.create({
  row: { position: "absolute", left: 0, right: 0, height: browseLayout.hitTarget, flexDirection: "row", alignItems: "center", gap: deckChromeLayout.headerGap },
  switcher: { flexShrink: 1 },
  switcherPress: { height: deckLook.switcherHeight, justifyContent: "center", paddingLeft: deckLook.switcherLead, paddingRight: deckLook.switcherTrail },
  spacer: { flex: 1 },
  fallback: { fontWeight: "600" },
  pillHit: { minHeight: browseLayout.hitTarget, justifyContent: "center" },
  pill: { flexDirection: "row", alignItems: "center", gap: deckChromeLayout.pillSpacing, height: deckChromeLayout.pillHeight, paddingHorizontal: deckChromeLayout.pillPadding },
  count: { fontWeight: "600", fontVariant: ["tabular-nums"], color: deckChromeInk.pill },
});
