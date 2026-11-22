import { memo, useEffect, useRef, useState } from "react";
import { haptics } from "../../state/app/haptics";
import { Pressable, ScrollView, type ScrollViewInstance, StyleSheet, Text, View, type ViewInstance } from "react-native";
import Animated, { FadeOut, LinearTransition, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import type { DeckGeometry } from "../../lib/deckGeometry";
import { shownTone } from "../../lib/pageTone";
import { useHeldPageTone } from "../../state/browse/deckHold";
import { menuOpenedHaptic } from "../../state/browse/tabMenus";
import { display } from "../../state/search/omnibox";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { isUnseenReceived } from "../../lib/tabFace";
import { capsule, ChromeSurface, deckChromeLayout, FadeView, font, screenReaderActions, Symbol, TabFace, tabsLayout, tabsMotion, useTheme } from "../ui";
import { CARD_MENU_ACTION, CardIcon, CardMenu, ReceivedBadge, type Reads } from "./DeckCard";
import { nativeMenus } from "../ui/MenuTrigger";
import { deckHeaderBottom } from "./DeckHeader";
import { centredGridOffset, tabGridColumns, tabGridInk, tabGridInsets, tabGridLayout, tabGridMotion, tabGridRowHeight, tabGridStartOffset } from "./tabGridLayout";
import { t } from "../../lib/uiLanguage";


export type GridFrame = { centerX: number; centerY: number; width: number; height: number };

type Props = {
  tabs: readonly BrowserTab[];
  selectedId: string | null;
  geometry: DeckGeometry;
  reduceMotion: boolean;
  shown?: boolean;
  covering?: Reads<string>;
  onFocusFrame?: (id: string, frame: GridFrame) => void;
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
};

type CellLayout = { x: number; y: number; width: number; height: number };

export function TabGrid({ tabs, selectedId, geometry: g, reduceMotion, shown = true, covering, onFocusFrame, onOpen, onClose }: Props) {
  const insets = tabGridInsets(g.safeTop, deckHeaderBottom(), g.height, g.barCenterY, deckChromeLayout.barCircle, g.safeSide + deckChromeLayout.headerSide);
  const columns = tabGridColumns(g.width - insets.side * 2);
  const aspect = g.width / Math.max(g.height, 1);
  const viewportTop = insets.top - tabGridLayout.topFade;
  const wanted = selectedId && tabs.some((tab) => tab.id === selectedId) ? selectedId : (tabs[tabs.length - 1]?.id ?? null);
  const [focusId, setFocusId] = useState(wanted);
  if (!shown && focusId !== wanted) setFocusId(wanted);
  const [startOffset] = useState(() => {
    const focus = tabs.findIndex((tab) => tab.id === focusId);
    return tabGridStartOffset(focus, tabs.length, columns.count, tabGridRowHeight(columns.width, aspect), g.height - viewportTop, insets.bottom);
  });
  const scroll = useRef<ScrollViewInstance>(null);
  const measured = useRef<{ viewport?: number; content?: number; cells: Map<string, CellLayout>; centred: string | null; offset: number }>({ cells: new Map(), centred: null, offset: startOffset });
  const centre = () => {
    const m = measured.current;
    const cell = focusId ? m.cells.get(focusId) : undefined;
    if (!focusId || m.viewport === undefined || m.content === undefined || !cell) return;
    if (!shown || m.centred !== focusId) {
      m.centred = focusId;
      m.offset = centredGridOffset(cell.y, cell.height, m.viewport, m.content);
      scroll.current?.scrollTo({ x: 0, y: m.offset, animated: false });
    }
    if (shown || !onFocusFrame) return;
    const height = cell.width / Math.max(aspect, 0.01);
    onFocusFrame(focusId, { centerX: cell.x + cell.width / 2, centerY: viewportTop + cell.y + tabGridLayout.closeHit.height + tabGridLayout.cellSpacing + height / 2 - m.offset, width: cell.width, height });
  };
  useEffect(() => {
    if (shown) return;
    measured.current.centred = null;
    centre();
  }, [shown, focusId]);
  const reflow = reduceMotion ? LinearTransition.duration(tabsMotion.fade) : LinearTransition.springify().stiffness(tabGridMotion.reflow.stiffness).damping(tabGridMotion.reflow.damping).mass(tabGridMotion.reflow.mass);
  const leave = FadeOut.duration(tabsMotion.fade);
  return (
    <FadeView testID="tabGrid" top={{ length: tabGridLayout.topFade }} style={[styles.viewport, { top: viewportTop }]}>
      <ScrollView
        testID="tabGridScroll"
        ref={scroll}
        contentOffset={{ x: 0, y: startOffset }}
        onLayout={(event) => {
          measured.current.viewport = event.nativeEvent.layout.height;
          centre();
        }}
        onContentSizeChange={(_width, height) => {
          measured.current.content = height;
          centre();
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingTop: tabGridLayout.topFade, paddingBottom: insets.bottom, paddingHorizontal: insets.side }]}
      >
        {tabs.map((tab) => (
          <Animated.View
            key={tab.id}
            testID="tabGridCell"
            layout={reflow}
            exiting={leave}
            style={{ width: columns.width }}
            onLayout={(event) => {
              const { x, y, width, height } = event.nativeEvent.layout;
              measured.current.cells.set(tab.id, { x, y, width, height });
              if (tab.id === focusId) centre();
            }}
          >
            <TabGridCell tab={tab} selected={tab.id === selectedId} width={columns.width} aspect={aspect} covering={covering} onOpen={onOpen} onClose={onClose} />
          </Animated.View>
        ))}
      </ScrollView>
    </FadeView>
  );
}

type CellProps = { tab: BrowserTab; selected: boolean; width: number; aspect: number; covering?: Reads<string>; onOpen: (id: string) => void; onClose: (id: string) => void };

const TabGridCell = memo(function TabGridCell({ tab, selected, width, aspect, covering, onOpen, onClose }: CellProps) {
  const theme = useTheme();
  const tone = shownTone(useHeldPageTone(tab.id), tab.themeColorHex);
  const host = display(tab.url).host;
  const title = tab.title || host || t(`New Tab`);
  const open = () => onOpen(tab.id);
  const close = () => onClose(tab.id);
  const scale = useSharedValue(1);
  const card = useRef<ViewInstance>(null);
  const id = tab.id;
  const pressStyle = useAnimatedStyle(() => ({ opacity: covering && covering.value === id ? 0 : 1, transform: [{ scale: scale.value }] }), [covering, id]);
  const press = (to: number) => {
    scale.value = withSpring(to, tabGridMotion.press);
  };
  const fill = tone.top ?? theme.surface;
  return (
    <View style={styles.cell}>
      <View testID="tabGridHeader" style={styles.header}>
        <CardIcon tab={tab} />
        <Text testID="tabGridTitle" style={[font.footnote, styles.title, { color: theme.headerText }]} numberOfLines={1}>
          {tab.isPrivate ? t(`Incognito`) : title}
        </Text>
        <Pressable testID="tabGridClose" accessibilityRole="button" accessibilityLabel={t(`Close Tab`)} onPress={close} style={styles.closeHit}>
          <ChromeSurface shape="circle" cornerRadius={capsule(tabGridLayout.closeCircle)} dark={theme.dark} style={styles.closeCircle}>
            <Symbol name="xmark" size={tabGridLayout.closeGlyph} color={theme.secondaryLabel} />
          </ChromeSurface>
        </Pressable>
      </View>
      <CardMenu testID="tabGridCardMenu" tab={tab} close={close} haptic={menuOpenedHaptic}>
        {({ onLongPress, openFor }) => (
          <Pressable
            ref={card}
            testID="tabGridCard"
            accessibilityRole="button"
            accessibilityLabel={title}
            accessibilityValue={{ text: tab.isPrivate ? `Incognito, ${host}` : host }}
            accessibilityState={{ selected }}
            {...screenReaderActions([
              { name: "activate", run: open },
              { name: "close", label: t(`Close Tab`), run: close },
              ...(onLongPress && !nativeMenus() ? [{ name: "menu", label: CARD_MENU_ACTION, run: () => (openFor ? openFor(card.current) : onLongPress()) }] : []),
            ])}
            onPress={open}
            onLongPress={onLongPress}
            onPressIn={() => {
              haptics.barPress();
              press(tabGridLayout.pressedScale);
            }}
            onPressOut={() => press(1)}
          >
            <Animated.View testID="tabGridFace" style={[styles.card, { width, height: width / aspect, backgroundColor: fill }, pressStyle]}>
              <TabFace tab={tab} title={title} host={host} tone={tone.top} roles={theme} paintedAs={`deck:${tab.id}`} />
              {isUnseenReceived(tab) ? <ReceivedBadge /> : null}
              <View
                testID="tabGridEdge"
                pointerEvents="none"
                style={[styles.edge, selected ? { borderWidth: tabGridLayout.selectedEdge, borderColor: theme.spaceAccentInk } : { borderWidth: tabGridLayout.edge, borderColor: theme.cardEdge }]}
              />
            </Animated.View>
          </Pressable>
        )}
      </CardMenu>
    </View>
  );
});

const styles = StyleSheet.create({
  viewport: { position: "absolute", left: 0, right: 0, bottom: 0 },
  content: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", columnGap: tabGridLayout.columnSpacing, rowGap: tabGridLayout.rowSpacing },
  cell: { gap: tabGridLayout.cellSpacing },
  header: { flexDirection: "row", alignItems: "center", gap: tabGridLayout.headerSpacing, height: tabGridLayout.closeHit.height },
  title: { flex: 1, fontWeight: "500" },
  closeHit: { width: tabGridLayout.closeHit.width, height: tabGridLayout.closeHit.height, alignItems: "center", justifyContent: "center" },
  closeCircle: { width: tabGridLayout.closeCircle, height: tabGridLayout.closeCircle, alignItems: "center", justifyContent: "center" },
  card: { borderRadius: tabsLayout.cardRadius, borderCurve: "continuous", overflow: "hidden", boxShadow: tabGridInk.shadow },
  edge: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, borderRadius: tabsLayout.cardRadius, borderCurve: "continuous" },
});
