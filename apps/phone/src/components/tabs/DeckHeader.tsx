import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { withSpring } from "react-native-reanimated";
import { haptics } from "../../state/app/haptics";
import { newIncognitoTab, openArchive, openSpaces, reopenLastClosed } from "../../state/browse/store";
import { menuOpenedHaptic } from "../../state/browse/tabMenus";
import { openSettings } from "../../state/settings/hooks";
import { selectProfile } from "../../state/sync/actions";
import { useSelectedProfile, useSyncStatus, useSyncView } from "../../state/sync/hooks";
import { useCanReopen, useIncognito } from "../../state/tabs/hooks";
import { prepareArchive } from "../../state/tabs/store";
import { countUsage } from "../../state/telemetry/telemetry";
import { browseLayout, capsule, deckChromeInk, deckChromeLayout, deckChromeMotion, font, rolesFor, startLayout, Symbol, tabsInk, tabsLayout, useTheme, type MenuItem } from "../ui";
import { MenuTrigger, spaceSystemImage } from "../ui/MenuTrigger";
import { emojiOf, SpaceTitle, spaceMenuSymbol } from "../search/StartSpaces";
import type { SyncedProfile } from "../../state/sync/store";
import { FadingGlyphs, GlassCircleButton, type ChromeFade } from "./ChromeButtons";

type Props = {
  safeTop: number;
  safeSide: number;
  privateCount: number;
  hasTabs: boolean;
  onCloseIncognito: () => void;
  onCloseAll: () => void;
  menusShown?: boolean;
  showsMore?: boolean;
  onMenu?: (open: boolean) => void;
} & ChromeFade;

export const deckHeaderBottom = () => deckChromeLayout.headerCenter + deckChromeLayout.headerCircle / 2;

export const deckArchiveBottom = () => deckChromeLayout.archiveCenter + deckChromeLayout.archiveHeight / 2;

export function deckMoreMenuItems({ syncEnabled, canReopen, hasTabs, onCloseAll }: { syncEnabled: boolean; canReopen: boolean; hasTabs: boolean; onCloseAll: () => void }): MenuItem[] {
  return [
    { label: "Archive", onPress: openArchive },
    ...(syncEnabled ? [{ label: "Spaces From Your Mac", onPress: openSpaces }] : []),
    "divider",
    { label: "New Incognito Tab", onPress: newIncognitoTab },
    ...(canReopen ? [{ label: "Reopen Closed Tab", onPress: reopenLastClosed }] : []),
    ...(hasTabs ? [{ label: "Close All Tabs", destructive: true, onPress: onCloseAll }] : []),
    "divider",
    { label: "Settings", onPress: () => openSettings() },
  ];
}

export function DeckHeader({ safeTop, safeSide, privateCount, hasTabs, onCloseIncognito, onCloseAll, menusShown = true, showsMore = true, onMenu, glassShown, glassShownMs, glyphFade }: Props) {
  const theme = useTheme();
  const status = useSyncStatus();
  const view = useSyncView();
  const shown = useSelectedProfile();
  const canReopen = useCanReopen();
  const incognito = useIncognito();
  const spaces = status.isEnabled ? view.profiles : [];
  const current = shown ?? spaces[0] ?? null;
  const side = safeSide + deckChromeLayout.headerSide;
  const below = safeTop + deckHeaderBottom() + deckChromeLayout.menuGap;
  const opened = () => onMenu?.(true);
  const closed = () => onMenu?.(false);
  const openedMore = () => {
    opened();
    prepareArchive();
  };
  const menu = { trigger: "tap" as const, fixedOrder: true, haptic: menuOpenedHaptic, disabled: !menusShown, onOpen: opened, onClose: closed };
  const choose = (id: string) => {
    if (id === current?.syncId) return;
    haptics.selection();
    if (!incognito) countUsage("spaces_picked");
    selectProfile(id);
  };
  const spaceItems: MenuItem[] = spaces.map((space) => ({ label: space.name, icon: spaceMenuSymbol(space) ?? undefined, systemImage: spaceSystemImage(space.name, space.icon), checked: space.syncId === current?.syncId, onPress: () => choose(space.syncId) }));
  const moreItems = deckMoreMenuItems({ syncEnabled: status.isEnabled, canReopen, hasTabs, onCloseAll });
  const pillItems: MenuItem[] = [{ label: "Close Incognito Tabs", destructive: true, onPress: onCloseIncognito }];
  return (
    <View testID="deckHeader" pointerEvents="box-none" style={[styles.row, { top: safeTop + deckChromeLayout.headerCenter - browseLayout.hitTarget / 2, paddingHorizontal: side }]}>
      <FadingGlyphs testID="deckSwitcher" fade={glyphFade} style={styles.switcher}>
        {current && spaces.length > 1 ? (
          <MenuTrigger items={spaceItems} {...menu} place={{ top: below, left: side, width: tabsLayout.menuWidth }}>
            {({ onPress }) => (
              <Pressable accessibilityRole="button" accessibilityLabel={`Space, ${current.name}`} accessibilityHint="Shows your Mac’s spaces." onPress={onPress}>
                <DeckSpaceTitle space={current} dark={theme.dark} showsChevron />
              </Pressable>
            )}
          </MenuTrigger>
        ) : current ? (
          <View accessible accessibilityRole="header" accessibilityLabel={current.name}>
            <DeckSpaceTitle space={current} dark={theme.dark} showsChevron={false} />
          </View>
        ) : (
          <Text accessibilityRole="header" numberOfLines={1} style={[font.body, styles.fallback, { color: theme.headerText }]}>
            Tabs
          </Text>
        )}
      </FadingGlyphs>
      <View style={styles.spacer} />
      {privateCount > 0 ? (
        <Animated.View entering={pillIn} exiting={pillOut}>
          <FadingGlyphs testID="deckIncognitoPillFade" fade={glyphFade}>
            <MenuTrigger items={pillItems} {...menu} place={{ top: below, right: showsMore ? side + deckChromeLayout.headerCircle + deckChromeLayout.headerGap : side, width: tabsLayout.menuWidth }}>
              {({ onPress }) => <IncognitoPill count={privateCount} onPress={onPress ?? noop} />}
            </MenuTrigger>
          </FadingGlyphs>
        </Animated.View>
      ) : null}
      {showsMore ? (
        <MenuTrigger items={moreItems} {...menu} onOpen={Platform.OS === "ios" ? openedMore : opened} place={{ top: below, right: side, width: tabsLayout.menuWidth }}>
          {({ onPress }) => <GlassCircleButton icon="ellipsis" label="More" testID="deckHeaderMore" diameter={deckChromeLayout.headerCircle} dark={theme.dark} glassShown={glassShown} glassShownMs={glassShownMs} glyphFade={glyphFade} onPress={onPress ?? noop} />}
        </MenuTrigger>
      ) : null}
    </View>
  );
}

const noop = () => undefined;

export const spaceHasIcon = (space: SyncedProfile) => spaceMenuSymbol(space) !== null || emojiOf(space.icon) !== null;

function DeckSpaceTitle({ space, dark, showsChevron }: { space: SyncedProfile; dark: boolean; showsChevron: boolean }) {
  if (spaceHasIcon(space)) return <SpaceTitle space={space} dark={dark} showsChevron={showsChevron} />;
  const roles = rolesFor(dark);
  return (
    <View testID="deckSpaceTitle" style={styles.title}>
      <Text style={[font.body, styles.titleText, { color: roles.headerText }]} numberOfLines={1}>
        {space.name}
      </Text>
      {showsChevron ? <Symbol name="chevronDown" size={startLayout.chevron} color={roles.secondaryLabel} /> : null}
    </View>
  );
}

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
      <View pointerEvents="none" style={[styles.pill, { backgroundColor: tabsInk.incognitoCard, borderRadius: capsule(deckChromeLayout.pillHeight) }]}>
        <Symbol name="eyes" size={deckChromeLayout.pillGlyph} color={deckChromeInk.pill} />
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
  spacer: { flex: 1 },
  fallback: { fontWeight: "600" },
  title: { flexDirection: "row", alignItems: "center", gap: startLayout.titleSpacing, minHeight: browseLayout.hitTarget },
  titleText: { flexShrink: 1, fontWeight: "600" },
  pillHit: { minHeight: browseLayout.hitTarget, justifyContent: "center" },
  pill: { flexDirection: "row", alignItems: "center", gap: deckChromeLayout.pillSpacing, height: deckChromeLayout.pillHeight, paddingHorizontal: deckChromeLayout.pillPadding },
  count: { fontWeight: "600", fontVariant: ["tabular-nums"], color: deckChromeInk.pill },
});
