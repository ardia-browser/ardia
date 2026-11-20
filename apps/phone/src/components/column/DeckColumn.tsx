import { useEffect } from "react";
import { StyleSheet } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { menuOpenedHaptic } from "../../state/browse/tabMenus";
import { columnContentWidth, SCREEN_COLUMN, type ScreenColumn } from "../../state/app/screenLayout";
import { useSyncStatus } from "../../state/sync/hooks";
import { useCanReopen } from "../../state/tabs/hooks";
import { deckChromeLayout, tabsCurve, tabsLayout, useTheme } from "../ui";
import { MenuTrigger } from "../ui/MenuTrigger";
import { GlassCircleButton, type ChromeFade } from "../tabs/ChromeButtons";
import { PlusMenuButton, SearchTabsField, useSearchTabs } from "../tabs/DeckBottomBar";
import { deckMoreMenuItems } from "../tabs/DeckHeader";
import { columnLayout } from "./columnTokens";
import { columnContentFrame, columnFieldCenterY, columnMenuPlace, SideColumn } from "./SideColumn";

type Props = {
  column: ScreenColumn;
  width: number;
  shown: boolean;
  incognito: boolean;
  hasTabs: boolean;
  onQuery: (needle: string) => void;
  onCloseAll: () => void;
  menusShown?: boolean;
  onMenu?: (open: boolean) => void;
} & ChromeFade;

export function DeckColumn({ column, width, shown, incognito, hasTabs, onQuery, onCloseAll, menusShown = true, onMenu, glassShown, glassShownMs, glyphFade }: Props) {
  const fade = { glassShown, glassShownMs, glyphFade };
  const dark = useTheme().dark;
  const syncEnabled = useSyncStatus().isEnabled;
  const canReopen = useCanReopen();
  const search = useSearchTabs(shown, incognito, onQuery);
  const showsField = search.focused || search.text !== "";
  const fieldOpacity = useSharedValue(showsField ? 1 : 0);
  useEffect(() => {
    fieldOpacity.value = withTiming(showsField ? 1 : 0, { duration: columnLayout.fieldFadeMs, easing: tabsCurve.easeInOut });
  }, [showsField]);
  const fieldStyle = useAnimatedStyle(() => ({ opacity: fieldOpacity.value }));
  const content = columnContentFrame(column, width);
  const fieldWidth = Math.max(columnContentWidth(column, width) - SCREEN_COLUMN.fieldSide * 2, 0);
  const menu = { fixedOrder: true, haptic: menuOpenedHaptic, disabled: !menusShown, onOpen: () => onMenu?.(true), onClose: () => onMenu?.(false) };
  const moreTop = SCREEN_COLUMN.top + SCREEN_COLUMN.button + SCREEN_COLUMN.spacing;
  const plusTop = moreTop + SCREEN_COLUMN.button + SCREEN_COLUMN.spacing;
  return (
    <>
      <Animated.View
        testID="deckColumnField"
        collapsable={false}
        pointerEvents={showsField ? "box-none" : "none"}
        importantForAccessibility={showsField ? "auto" : "no-hide-descendants"}
        accessibilityElementsHidden={!showsField}
        style={[styles.field, { left: content.left + SCREEN_COLUMN.fieldSide, width: fieldWidth, top: columnFieldCenterY() - deckChromeLayout.barCircle / 2 }, fieldStyle]}
      >
        <SearchTabsField search={search} style={styles.fieldHit} {...fade} />
      </Animated.View>
      <SideColumn column={column} width={width} testID="deckColumn">
        <GlassCircleButton icon="magnifyingglass" label="Search Tabs" testID="deckColumnSearch" diameter={SCREEN_COLUMN.button} dark={dark} {...fade} onPress={() => search.input.current?.focus()} />
        <MenuTrigger items={deckMoreMenuItems({ syncEnabled, canReopen, hasTabs, onCloseAll })} trigger="tap" frost={null} {...menu} place={{ ...columnMenuPlace(column, width, moreTop), width: tabsLayout.menuWidth }}>
          {({ onPress }) => <GlassCircleButton icon="ellipsis" label="More" testID="deckColumnMore" diameter={SCREEN_COLUMN.button} dark={dark} {...fade} onPress={onPress ?? noop} />}
        </MenuTrigger>
        <PlusMenuButton frost={null} width={SCREEN_COLUMN.button} label={incognito ? "New Incognito Tab" : "New Tab"} testID="deckColumnPlus" dark={dark} place={{ ...columnMenuPlace(column, width, plusTop), width: tabsLayout.menuWidth }} menusShown={menusShown} onMenu={onMenu} {...fade} />
      </SideColumn>
    </>
  );
}

const noop = () => undefined;

const styles = StyleSheet.create({
  field: { position: "absolute", height: deckChromeLayout.barCircle, flexDirection: "row" },
  fieldHit: { flex: 1, height: deckChromeLayout.barCircle },
});
