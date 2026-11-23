import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, ScrollView, StyleSheet, View } from "react-native";
import { clickVaultRow, stepVaultMenu } from "../../state/vaults/fill";
import { closeVaultMenu, hoverVaultMenu, noteVaultSearchFocus, useVaultMenus, offerToFocusedField, restingRowOf, searchVaultMenu, selectVaultRow, setVaultMenuOffscreen, showVaultMatches, type VaultMenu as MenuState } from "../../state/vaults/menu";
import { FOOTER_KINDS, GENERATOR_STYLES, type VaultRow } from "../../state/vaults/menuModel";
import { scrollToKeep } from "../../state/vaults/menuScroll";
import { siteLabel } from "../../state/vaults/originMatch";
import { useVaultMenu, useVaultMenuGlass, useVaultMenuRows, useVaultTouchID } from "../../state/vaults/hooks";
import { armVaultTouchID, isTouchRow, noteVaultTouchStatus, touchIDGlyphShown, touchScopeOf } from "../../state/vaults/touchID";
import { useWindowInFront } from "../../state/windows/inFront";
import { useAppActive } from "../../state/app/appActive";
import { vaultHighlight } from "../../state/vaults/highlight";
import { over } from "../../lib/color";
import { useSettings, useTab, useTabLive } from "../../state/browser/hooks";
import { anchoredClose, anchoredOpen, Button, Divider, Expand, GlassFill, ink, liquidGlass, PANEL, Panel, POPOVER_MARGIN, PopoverSurface, reduceMotion, SearchField, selectionSlide, shadow, space, Text, useTheme, VaultTouchID, withAlpha } from "../ui";
import { twinLogins } from "./rowText";
import { CodesTicking, rowHeight, VaultRowView, type RowLayer } from "./VaultRows";
import { VAULT_MENU } from "./tokens";

type Area = { width: number; height: number };

export function useLeavingMenu<M extends { seq: number; hidden: boolean }>(menu: M | null) {
  const last = useRef<M | null>(menu);
  const [leaving, setLeaving] = useState<M | null>(null);
  const gone = last.current;
  if (gone && gone.seq !== menu?.seq) {
    last.current = menu;
    if (!gone.hidden) setLeaving(gone);
  } else last.current = menu;
  const done = (menuSeq: number) => setLeaving((l) => (l?.seq === menuSeq ? null : l));
  return { leaving: leaving && leaving.seq !== menu?.seq ? leaving : null, done };
}

export function VaultMenuHost({ tabId, zoom }: { tabId: string; zoom: number }) {
  const menu = useVaultMenu(tabId);
  const [area, setArea] = useState<Area>({ width: 0, height: 0 });
  const { leaving, done } = useLeavingMenu(menu);
  useEffect(() => {
    offerToFocusedField(tabId);
    return () => closeVaultMenu(tabId);
  }, [tabId]);
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill} onLayout={(e) => setArea(e.nativeEvent.layout)}>
      {leaving && area.width > 0 ? <MenuPanel key={leaving.seq} tabId={tabId} menu={leaving} zoom={zoom} area={area} onGone={() => done(leaving.seq)} /> : null}
      {menu && area.width > 0 ? <MenuPanel key={menu.seq} tabId={tabId} menu={menu} zoom={zoom} area={area} /> : null}
    </View>
  );
}

const footerHeight = (rows: number) => rows * VAULT_MENU.compactRow + 2 * VAULT_MENU.separatorGap + VAULT_MENU.footerBottom;

export function placement(menu: Pick<MenuState, "rect">, zoom: number, area: Area, height: number) {
  const r = menu.rect ?? { x: POPOVER_MARGIN / zoom, y: 0, width: 0, height: 0 };
  const top = r.y * zoom;
  const bottom = (r.y + r.height) * zoom;
  const offscreen = !!menu.rect && (bottom < 0 || top > area.height);
  const width = Math.min(area.width - 2 * POPOVER_MARGIN, Math.max(VAULT_MENU.minWidth, Math.min(VAULT_MENU.maxWidth, r.width * zoom)));
  const left = Math.max(POPOVER_MARGIN, Math.min(r.x * zoom, area.width - width - POPOVER_MARGIN));
  const below = area.height - POPOVER_MARGIN - (bottom + VAULT_MENU.gap);
  const above = top - VAULT_MENU.gap - POPOVER_MARGIN;
  const upward = height > below && above > below;
  const room = Math.max(0, upward ? above : below);
  const y = upward ? top - VAULT_MENU.gap - Math.min(height, room) : Math.max(POPOVER_MARGIN, bottom + VAULT_MENU.gap);
  const anchor = upward && height <= room ? { bottom: area.height - (top - VAULT_MENU.gap) } : { top: y };
  return { offscreen, width, left, upward, room, anchor };
}

export function useWholeList() {
  const [whole, setWhole] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setWhole(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return whole;
}

const isSpare = (row: VaultRow) => row.kind === "generate" && !!row.spare;

export function SelectionPlate({ index, offsets, fill, accessory, children }: { index: number; offsets: readonly number[]; fill: string; accessory?: ReactNode; children?: ReactNode }) {
  const y = useRef(new Animated.Value(offsets[index] ?? 0)).current;
  const shownAt = useRef(-1);
  const at = offsets[index];
  useEffect(() => {
    if (at === undefined) return void (shownAt.current = -1);
    const from = shownAt.current;
    shownAt.current = index;
    if (from < 0 || reduceMotion() === true) return y.setValue(at);
    const run = Animated.timing(y, { toValue: at, ...selectionSlide, useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, [index, at]);
  const back = useMemo(() => Animated.multiply(y, -1), [y]);
  if (at === undefined) return null;
  return (
    <Animated.View pointerEvents="none" style={{ ...PLATE, borderRadius: VAULT_MENU.rowRadius, backgroundColor: fill, transform: [{ translateY: y }] }}>
      {children ? <Animated.View style={{ ...PLATE_CONTENT, transform: [{ translateY: back }] }}>{children}</Animated.View> : null}
      {accessory ? <View style={PLATE_ACCESSORY}>{accessory}</View> : null}
    </Animated.View>
  );
}

export function MenuSurface({ glass, children }: { glass: boolean; children: ReactNode }) {
  const theme = useTheme();
  if (!glass) return <PopoverSurface>{children}</PopoverSurface>;
  const veil = over(theme.popoverFill, theme.dark ? ink.black : ink.white);
  return (
    <Panel fill={ink.clear} radius={PANEL.radius} border={theme.popoverBorder} shadow={shadow.popover} material={VAULT_MENU.glassMaterial}>
      <GlassFill panelFill={theme.popoverFill} tint={withAlpha(veil, VAULT_MENU.glassTint)} radius={PANEL.radius} />
      {children}
    </Panel>
  );
}

function MenuPanel({ tabId, menu, zoom, area, onGone }: { tabId: string; menu: MenuState; zoom: number; area: Area; onGone?: () => void }) {
  const leaving = !!onGone;
  const rows = useVaultMenuRows(menu);
  const theme = useTheme();
  const fieldColor = useVaultMenus((s) => s.fields[tabId]?.brandColor ?? null);
  const pageColor = useTabLive(tabId, (l) => l.themeColor);
  const websiteColor = fieldColor ?? pageColor;
  const extendWebsiteColor = useSettings((s) => s.extendWebsiteColor);
  const glass = useVaultMenuGlass() && liquidGlass;
  const surface = glass ? (theme.dark ? VAULT_MENU.glassSurface.dark : VAULT_MENU.glassSurface.light) : over(theme.popoverFill, theme.dark ? ink.black : ink.white);
  const highlight = useMemo(() => vaultHighlight(websiteColor, extendWebsiteColor, theme.formAccent, surface), [websiteColor, extendWebsiteColor, theme, surface]);
  const [height, setHeight] = useState(0);
  const appear = useRef(new Animated.Value(0)).current;
  const scroll = useRef<ScrollView>(null);
  const scrollTop = useRef(0);
  const place = placement(menu, zoom, area, height);
  const still = reduceMotion() === true;
  const ticking = useAppActive() && !menu.hidden && !leaving;
  useEffect(() => {
    if (leaving || !height) return;
    const run = Animated.timing(appear, { toValue: 1, duration: anchoredOpen.duration, easing: anchoredOpen.easing, useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, [height > 0]);
  useEffect(() => {
    if (!onGone) return;
    const run = Animated.timing(appear, { toValue: 0, ...anchoredClose, useNativeDriver: true });
    run.start(() => onGone());
    return () => run.stop();
  }, [leaving]);
  useEffect(() => {
    if (!leaving) setVaultMenuOffscreen(tabId, menu.seq, place.offscreen);
  }, [place.offscreen]);
  const list = rows.filter((r) => !FOOTER_KINDS.has(r.kind));
  const footer = rows.filter((r) => FOOTER_KINDS.has(r.kind));
  const firstSpare = list.findIndex(isSpare);
  const allSettled = firstSpare < 0 ? list : list.slice(0, firstSpare);
  const whole = useWholeList();
  const settled = whole ? allSettled : allSettled.slice(0, VAULT_MENU.visibleRows + 1);
  const suggestAt = footer.findIndex((r) => r.kind === "suggest");
  const listRoom = Math.max(VAULT_MENU.minList, Math.min(VAULT_MENU.maxList, place.room - (footer.length ? footerHeight(footer.length) : 0) - (menu.mode === "search" ? VAULT_MENU.searchHeight : 0)));
  const offsets = useMemo(() => {
    let at = 0;
    return list.map((r) => (at += rowHeight(r)) - rowHeight(r));
  }, [rows]);
  const contentHeight = useRef(0);
  useEffect(() => {
    if (menu.selected < 0 || menu.selected >= list.length) return;
    const start = VAULT_MENU.listPad + offsets[menu.selected]!;
    const y = scrollToKeep({ start, end: start + rowHeight(list[menu.selected]!) }, { top: scrollTop.current, room: listRoom, content: contentHeight.current || Number.POSITIVE_INFINITY, inset: VAULT_MENU.listPad });
    if (y === null) return;
    scrollTop.current = y;
    scroll.current?.scrollTo({ y, animated: false });
  }, [menu.selected, whole, listRoom, offsets]);
  const touchIDReady = useVaultTouchID();
  const windowId = useTab(tabId, (t) => t?.windowId);
  const inFront = useWindowInFront(windowId);
  const shownSelected = inFront ? menu.selected : -1;
  const selectedRow = list[shownSelected];
  const touchTarget = leaving || !touchIDReady || menu.hidden || !touchIDGlyphShown(menu.touch) || !isTouchRow(selectedRow) ? -1 : shownSelected;
  useEffect(() => {
    if (!leaving && inFront && !menu.hovered && menu.mode === "matches") selectVaultRow(tabId, restingRowOf(menu));
  }, [inFront]);
  const touchArmed = touchTarget >= 0 && !menu.busy;
  useEffect(() => {
    armVaultTouchID(tabId, touchArmed ? menu.seq : null);
    return () => armVaultTouchID(tabId, null);
  }, [tabId, touchArmed, menu.seq]);
  const touch = { phase: menu.touch, retries: menu.touchRetries };
  const site = siteLabel(menu.origin);
  const twins = useMemo(() => twinLogins(list, site), [rows, site]);
  const unfolds = allSettled.reduce((sum, r) => sum + rowHeight(r), 0) + GENERATOR_STYLES.length * VAULT_MENU.row <= listRoom;
  const view = (row: VaultRow, index: number, layer?: RowLayer) => (
    <VaultRowView
      key={row.key}
      tabId={tabId}
      seq={menu.seq}
      row={row}
      site={site}
      twin={twins.has(row.key)}
      selected={shownSelected === index}
      plated={index < list.length}
      layer={layer}
      reserveTrailing={touchIDReady}
      highlight={highlight}
      touch={index === touchTarget && (layer === "lit" || index >= list.length) ? touch : null}
      busy={menu.busy === row.key}
      onHover={() => menu.selected !== index && selectVaultRow(tabId, index)}
      onPress={() => clickVaultRow(tabId, row)}
    />
  );
  const scale = appear.interpolate({ inputRange: [0, 1], outputRange: [anchoredOpen.fromScale, 1] });
  const motion = menu.hidden ? { opacity: 0 } : still ? { opacity: appear } : { opacity: appear, transform: [{ scale }] };
  return (
    <Animated.View
      pointerEvents={menu.hidden || leaving ? "none" : "auto"}
      accessibilityRole="menu"
      accessibilityLabel={menu.mode === "search" ? "All Passwords" : `Passwords for ${site}`}
      onMouseEnter={leaving ? undefined : () => hoverVaultMenu(tabId, true)}
      onMouseLeave={leaving ? undefined : () => hoverVaultMenu(tabId, false)}
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
      style={{ position: "absolute", left: place.left, ...place.anchor, width: place.width, transformOrigin: place.upward ? "left bottom" : "left top", ...motion }}
    >
      <CodesTicking.Provider value={ticking}>
        <MenuSurface glass={glass}>
          {menu.mode === "search" ? (
            <View style={SEARCH_ROW}>
              <Button variant="icon" icon="chevron.backward" size="s" tooltip="Back" onPress={() => showVaultMatches(tabId)} />
              <SearchField
                look="bare"
                autoFocus
                value={menu.query}
                placeholder="Search Passwords"
                onChangeText={(q) => searchVaultMenu(tabId, q)}
                onArrow={(step) => stepVaultMenu(tabId, step > 0 ? "ArrowDown" : "ArrowUp")}
                onSubmit={() => stepVaultMenu(tabId, "Enter")}
                onEscape={() => stepVaultMenu(tabId, "Escape")}
                onBlur={() => noteVaultSearchFocus(tabId, false)}
                style={FILL}
              />
            </View>
          ) : null}
          {list.length ? (
            <ScrollView
              ref={scroll}
              style={{ maxHeight: listRoom }}
              contentContainerStyle={footer.length ? LIST : LIST_ALONE}
              showsVerticalScrollIndicator={false}
              scrollEventThrottle={16}
              onScroll={(e) => (scrollTop.current = e.nativeEvent.contentOffset.y)}
              onContentSizeChange={(_, h) => (contentHeight.current = h)}
            >
              {settled.map((row, i) => view(row, i))}
              <Expand open={firstSpare >= 0} animate={unfolds}>
                {firstSpare >= 0 ? list.slice(firstSpare).map((row, i) => view(row, firstSpare + i)) : null}
              </Expand>
              <SelectionPlate
                index={shownSelected}
                offsets={offsets}
                fill={highlight.fill}
                accessory={touchTarget >= 0 ? <VaultTouchID key={menu.touchRearms} armed={touchArmed} grantScope={touchScopeOf(tabId, menu)} onStatus={(status) => noteVaultTouchStatus(tabId, menu.seq, status)} style={TOUCH_ID_SIZE} /> : null}
              >
                {list.map((row, i) => view(row, i, "lit"))}
              </SelectionPlate>
            </ScrollView>
          ) : (
            <View style={EMPTY}>
              <Text size="small" tone="textSecondary" lines={1}>
                {menu.mode === "search" ? "No Results" : `No Passwords for ${site}`}
              </Text>
            </View>
          )}
          <Expand open={!!menu.error}>
            <Text size="caption" tone="destructive" lines={2} style={ERROR}>
              {menu.error}
            </Text>
          </Expand>
          {footer.length ? (
            <View style={FOOTER}>
              <Divider style={SEPARATOR} />
              <View style={FOOTER_ROWS}>
                <Expand open={suggestAt >= 0} animate={unfolds}>
                  {suggestAt >= 0 ? view(footer[suggestAt]!, list.length + suggestAt) : null}
                </Expand>
                {footer.map((row, i) => (i === suggestAt ? null : view(row, list.length + i)))}
              </View>
            </View>
          ) : null}
        </MenuSurface>
      </CodesTicking.Provider>
    </Animated.View>
  );
}

const PLATE = { position: "absolute", top: VAULT_MENU.listPad, left: VAULT_MENU.rowInset, right: VAULT_MENU.rowInset, height: VAULT_MENU.row, overflow: "hidden" } as const;
const PLATE_ACCESSORY = { position: "absolute", right: VAULT_MENU.rowPadding, top: (VAULT_MENU.row - VAULT_MENU.touchID) / 2, width: VAULT_MENU.touchID, height: VAULT_MENU.touchID } as const;
const PLATE_CONTENT = { position: "absolute", top: 0, left: -VAULT_MENU.rowInset, right: -VAULT_MENU.rowInset } as const;
const FILL = { flex: 1 } as const;
const SEARCH_ROW = { flexDirection: "row", alignItems: "center", gap: space.xs, height: VAULT_MENU.searchHeight, paddingHorizontal: VAULT_MENU.rowInset } as const;
const LIST = { paddingTop: VAULT_MENU.listPad, paddingBottom: VAULT_MENU.separatorGap } as const;
const TOUCH_ID_SIZE = { width: VAULT_MENU.touchID, height: VAULT_MENU.touchID } as const;
const LIST_ALONE = { paddingVertical: VAULT_MENU.listPad } as const;
const SEPARATOR = { marginHorizontal: VAULT_MENU.separatorInset } as const;
const EMPTY = { height: VAULT_MENU.compactRow, justifyContent: "center", paddingHorizontal: VAULT_MENU.separatorInset, marginTop: VAULT_MENU.listPad, marginBottom: VAULT_MENU.separatorGap } as const;
const ERROR = { paddingHorizontal: PANEL.inset, paddingBottom: space.s } as const;
const FOOTER = { paddingBottom: VAULT_MENU.footerBottom } as const;
const FOOTER_ROWS = { paddingTop: VAULT_MENU.separatorGap } as const;
