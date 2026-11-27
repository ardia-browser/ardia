import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { actionWords, destinationWords } from "../../lib/sharedWords";
import { haptics } from "../../state/app/haptics";
import { openArchive, openSpaces } from "../../state/browse/store";
import { openLibraryFromDeck } from "../../state/library/store";
import { menuOpenedHaptic } from "../../state/browse/tabMenus";
import { openSettings } from "../../state/settings/hooks";
import { selectProfile } from "../../state/sync/actions";
import { useSelectedProfile, useSyncStatus, useSyncView } from "../../state/sync/hooks";
import { useIncognito } from "../../state/tabs/hooks";
import { countUsage } from "../../state/telemetry/telemetry";
import { browseLayout, ChromeSurface, deckChromeLayout, font, iconRoles, menuLook, Tappable, tabsLayout, useTheme, type MenuItem } from "../ui";
import { deckLook } from "./deckLook";
import { MenuTrigger, nativeMenus, spaceSystemImage, type MenuOpener } from "../ui/MenuTrigger";
import { SpaceTitle, spaceMenuSymbol } from "../search/StartSpaces";
import { FadingGlyphs, GlassCircleButton, type ChromeFade } from "./ChromeButtons";
import { DeckHitTarget } from "./DeckHitTarget";
import { useUpdateDot } from "../../state/appUpdate/store";
import type { BarSpan } from "../../lib/bottomBarSpan";

type Props = {
  safeTop: number;
  sides: BarSpan;
  stripSide?: "left" | "right" | null;
  showsMore?: boolean;
  width: number;
  menusShown?: boolean;
  onMenu?: (open: boolean) => void;
  moreOpener?: MenuOpener;
  spacesOpener?: MenuOpener;
  underlay?: boolean;
  hits?: boolean;
} & ChromeFade;

export const deckHeaderBottom = () => deckChromeLayout.headerCenter + deckChromeLayout.headerCircle / 2;

const menuGroupsRuled = () => nativeMenus() || menuLook.dividerLine > 0;

function joinMenuGroups(groups: readonly MenuItem[][], ruled: boolean = menuGroupsRuled()): MenuItem[] {
  return groups.filter((group) => group.length > 0).flatMap((group, index): MenuItem[] => (index > 0 && ruled ? ["divider", ...group] : group));
}

export function libraryMenuItems(material = false): MenuItem[] {
  return [
    { label: destinationWords.history, icon: "clockArrow", onPress: () => openLibraryFromDeck("history") },
    { label: destinationWords.bookmarks, icon: material ? "folderFill" : "star", onPress: () => openLibraryFromDeck("bookmarks") },
    { label: destinationWords.downloads, icon: "arrowDownCircle", onPress: () => openLibraryFromDeck("downloads") },
  ];
}

export function deckMoreMenuItems({ syncEnabled, archive = true, material = false, updateDot = false }: { syncEnabled: boolean; archive?: boolean; material?: boolean; updateDot?: boolean }): MenuItem[] {
  return joinMenuGroups(
    [
      [...(archive ? [{ label: destinationWords.archive, icon: "archivebox" as const, onPress: openArchive }] : []), ...(syncEnabled ? [{ label: destinationWords.spaces, icon: "macAndPhone" as const, onPress: openSpaces }] : [])],
      libraryMenuItems(material),
      [{ label: destinationWords.settings, icon: "gearshape", dot: updateDot, onPress: () => openSettings() }],
    ],
    material ? true : menuGroupsRuled(),
  );
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

type MoreProps = ChromeFade & {
  opener?: MenuOpener;
  place: ViewStyle;
  drawn?: boolean;
  diameter: number;
  testID: string;
  live: boolean;
  originX?: number;
  originY: number;
  hitStyle?: StyleProp<ViewStyle>;
  dark: boolean;
  underlay?: boolean;
  menusShown: boolean;
  onMenu?: (open: boolean) => void;
};

export function DeckMoreButton({ opener, place, drawn = false, diameter, testID, live, originX, originY, hitStyle, dark, underlay = false, menusShown, onMenu, glassShown, glassShownMs, glyphFade }: MoreProps) {
  const incognito = useIncognito();
  const updateDot = useUpdateDot();
  const syncEnabled = useSyncStatus().isEnabled;
  const items = deckMoreMenuItems({ syncEnabled, archive: false, updateDot });
  return (
    <DeckHitTarget control="more" live={live} originX={originX} originY={originY} style={hitStyle}>
      <MenuTrigger opener={opener} items={items} trigger="tap" fixedOrder haptic={menuOpenedHaptic} disabled={!menusShown} onOpen={() => onMenu?.(true)} onClose={() => onMenu?.(false)} previewRadius={diameter / 2} place={place} drawn={drawn}>
        {({ onPress }) => <GlassCircleButton icon={iconRoles.more} label={actionWords.more} testID={testID} diameter={diameter} incognito={incognito} dark={dark} glassShown={glassShown} glassShownMs={glassShownMs} glyphFade={glyphFade} underlay={underlay} onPress={onPress ?? noop} />}
      </MenuTrigger>
    </DeckHitTarget>
  );
}

export function DeckHeader({ safeTop, sides, stripSide = null, showsMore = true, width, menusShown = true, onMenu, moreOpener, spacesOpener, underlay = false, hits = false, glassShown, glassShownMs, glyphFade }: Props) {
  const theme = useTheme();
  const incognito = useIncognito();
  const { spaces, current, spaceItems } = useDeckSpaces();
  const below = safeTop + deckHeaderBottom() + deckChromeLayout.menuGap;
  const opened = () => onMenu?.(true);
  const closed = () => onMenu?.(false);
  const menu = { trigger: "tap" as const, fixedOrder: true, haptic: menuOpenedHaptic, disabled: !menusShown, onOpen: opened, onClose: closed };
  const rowTop = safeTop + deckChromeLayout.headerCenter - browseLayout.hitTarget / 2;
  const padding = sides.left === sides.right ? { paddingHorizontal: sides.left } : { paddingLeft: sides.left, paddingRight: sides.right };
  const centred = stripSide !== null;
  const moreLeads = stripSide === "left";
  const spacesLeft = centred ? Math.max((sides.left + width - sides.right - tabsLayout.menuWidth) / 2, sides.left) : sides.left;
  const more = showsMore ? (
    <DeckMoreButton
      opener={moreOpener}
      place={moreLeads ? { top: below, left: sides.left, width: tabsLayout.menuWidth } : { top: below, right: sides.right, width: tabsLayout.menuWidth }}
      diameter={deckChromeLayout.headerCircle}
      testID="deckHeaderMore"
      live={hits}
      originY={rowTop}
      hitStyle={centred ? [styles.pinned, moreLeads ? { left: sides.left } : { right: sides.right }] : undefined}
      dark={theme.dark}
      underlay={underlay}
      menusShown={menusShown}
      onMenu={onMenu}
      glassShown={glassShown}
      glassShownMs={glassShownMs}
      glyphFade={glyphFade}
    />
  ) : null;
  return (
    <View testID="deckHeader" pointerEvents="box-none" style={[styles.row, { top: rowTop }, padding]}>
      {centred ? <View testID="deckHeaderLead" pointerEvents="none" style={styles.flank} /> : null}
      {current && spaces.length > 1 ? (
        <DeckHitTarget control="spaces" live={hits} originY={rowTop} style={styles.switcher}>
        <MenuTrigger opener={spacesOpener} items={spaceItems} {...menu} previewRadius={deckLook.switcherCorner} place={{ top: below, left: spacesLeft, width: tabsLayout.menuWidth }}>
          {({ onPress }) => (
            <ChromeSurface testID="deckSwitcherGlass" shape="capsule" cornerRadius={deckLook.switcherCorner} incognito={incognito} dark={theme.dark} shown={glassShown} shownMs={glassShownMs} underlay={underlay}>
              <Tappable kind="text" label={`Space, ${current.name}`} hint="Shows your Mac’s spaces." onPress={onPress ?? noop} style={styles.switcherPress}>
                <FadingGlyphs testID="deckSwitcher" fade={glyphFade}>
                  <SpaceTitle space={current} dark={theme.dark} showsChevron />
                </FadingGlyphs>
              </Tappable>
            </ChromeSurface>
          )}
        </MenuTrigger>
        </DeckHitTarget>
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
      {centred ? (
        <>
          <View testID="deckHeaderTrail" pointerEvents="none" style={styles.flank} />
          {more}
        </>
      ) : (
        <>
          <View style={styles.spacer} />
          {more}
        </>
      )}
    </View>
  );
}

const noop = () => undefined;

const styles = StyleSheet.create({
  row: { position: "absolute", left: 0, right: 0, height: browseLayout.hitTarget, flexDirection: "row", alignItems: "center", gap: deckChromeLayout.headerGap },
  switcher: { flexShrink: 1 },
  switcherPress: { height: deckLook.switcherHeight, justifyContent: "center", paddingLeft: deckLook.switcherLead, paddingRight: deckLook.switcherTrail },
  spacer: { flex: 1 },
  flank: { flex: 1, flexBasis: 0, minWidth: deckChromeLayout.headerCircle },
  pinned: { position: "absolute", top: 0 },
  fallback: { fontWeight: "600" },
});
