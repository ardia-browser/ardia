import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, ScrollView, StyleSheet, View } from "react-native";
import {
  activateAutofillRow,
  armAutofillTouchID,
  autofillMenuOf,
  closeAutofillMenu,
  hoverAutofillMenu,
  noteAutofillTouchStatus,
  selectAutofillRow,
  setAutofillMenuOffscreen,
  touchScopeOfAutofill,
  useAutofillMenus,
  type AutofillMenu,
} from "../../state/autofill/fieldMenu";
import { autofillMenuRows, autofillRestingRow, isTouchCardRow, type AutofillRow } from "../../state/autofill/menuModel";
import { addresses, autofillEnabled, cards } from "../../state/settings/paneData";
import { useResource } from "../../state/settings/resources";
import { useSettings, useTab, useTabLive } from "../../state/browser/hooks";
import { vaultHighlight, type VaultHighlight } from "../../state/vaults/highlight";
import { useVaultMenuGlass, useVaultTouchID } from "../../state/vaults/hooks";
import { touchIDGlyphShown } from "../../state/vaults/touchID";
import { useWindowInFront } from "../../state/windows/inFront";
import { over } from "../../lib/color";
import { anchoredClose, anchoredOpen, Divider, Expand, ink, liquidGlass, reduceMotion, Text, useTheme, VaultTouchID } from "../ui";
import { NetworkBadge } from "../site/Autofill";
import { MenuSurface, placement, SelectionPlate, useLeavingMenu, useWholeList } from "../vaults/VaultMenu";
import { Lines, RowShell, Trailing, type Ink, type RowLayer, type VaultTouchState } from "../vaults/VaultRows";
import { VAULT_MENU } from "../vaults/tokens";
import { addressSymbol } from "./AutofillParts";
import { VaultAppIcon } from "../vaults/VaultParts";

type Area = { width: number; height: number };

const MANAGE_TITLE = {
  address: "Manage Addresses…",
  card: "Manage Cards…",
} as const;

const rowHeight = (row: AutofillRow) => (row.kind === "manage" ? VAULT_MENU.compactRow : VAULT_MENU.row);
const footerHeight = VAULT_MENU.compactRow + 2 * VAULT_MENU.separatorGap + VAULT_MENU.footerBottom;

export function AutofillMenuHost({ tabId }: { tabId: string }) {
  const menu = useAutofillMenus((s) => s.menus[tabId] ?? null);
  const [area, setArea] = useState<Area>({ width: 0, height: 0 });
  const { leaving, done } = useLeavingMenu(menu);
  useEffect(() => () => closeAutofillMenu(tabId), [tabId]);
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill} onLayout={(e) => setArea(e.nativeEvent.layout)}>
      {leaving && area.width > 0 ? <MenuPanel key={leaving.seq} tabId={tabId} menu={leaving} area={area} onGone={() => done(leaving.seq)} /> : null}
      {menu && area.width > 0 ? <MenuPanel key={menu.seq} tabId={tabId} menu={menu} area={area} /> : null}
    </View>
  );
}

function useRows(menu: AutofillMenu): AutofillRow[] {
  const [addressList] = useResource(addresses, menu.profile);
  const [cardList] = useResource(cards, menu.profile);
  const [enabled] = useResource(autofillEnabled, menu.profile);
  return useMemo(
    () =>
      autofillMenuRows({
        kind: menu.kind,
        part: menu.part,
        addresses: addressList ?? [],
        cards: cardList ?? [],
        enabled: enabled ?? { addresses: true, cards: true },
        now: new Date(),
      }),
    [menu.kind, menu.part, addressList, cardList, enabled],
  );
}

const EntryRow = memo(function EntryRow({
  tabId,
  row,
  selected,
  plated,
  layer,
  highlight,
  touch,
  busy,
  reserve,
  onHover,
}: {
  tabId: string;
  row: AutofillRow;
  selected: boolean;
  plated: boolean;
  layer?: RowLayer;
  highlight: VaultHighlight;
  touch: VaultTouchState | null;
  busy: boolean;
  reserve: boolean;
  onHover: () => void;
}) {
  const label = row.kind === "manage" ? MANAGE_TITLE[row.what] : [row.title, row.detail].filter(Boolean).join(", ");
  return (
    <RowShell
      label={label}
      height={rowHeight(row)}
      compact={row.kind === "manage"}
      selected={selected}
      plated={plated}
      layer={layer}
      highlight={highlight}
      onHover={onHover}
      onPress={() => void activateAutofillRow(tabId, row)}
    >
      {(ink: Ink, lit: boolean) =>
        row.kind === "manage" ? (
          <Lines title={label} ink={ink} />
        ) : (
          <>
            {row.kind === "card" ? (
              <View style={BADGE_SLOT}>
                <NetworkBadge network={row.card.network} />
              </View>
            ) : (
              <VaultAppIcon provider="" symbol={addressSymbol(row.address)} neutral />
            )}
            <Lines title={row.title} detail={row.detail || undefined} ink={ink} />
            <Trailing busy={busy} touch={touch} ink={ink} fill={lit ? highlight.fill : null} reserve={reserve && row.kind === "card"} />
          </>
        )
      }
    </RowShell>
  );
});

function MenuPanel({ tabId, menu, area, onGone }: { tabId: string; menu: AutofillMenu; area: Area; onGone?: () => void }) {
  const leaving = !!onGone;
  const rows = useRows(menu);
  const theme = useTheme();
  const websiteColor = useTabLive(tabId, (l) => l.themeColor);
  const extendWebsiteColor = useSettings((s) => s.extendWebsiteColor);
  const glass = useVaultMenuGlass() && liquidGlass;
  const surface = glass ? (theme.dark ? VAULT_MENU.glassSurface.dark : VAULT_MENU.glassSurface.light) : over(theme.popoverFill, theme.dark ? ink.black : ink.white);
  const highlight = useMemo(() => vaultHighlight(websiteColor, extendWebsiteColor, theme.formAccent, surface), [websiteColor, extendWebsiteColor, theme, surface]);
  const [height, setHeight] = useState(0);
  const appear = useRef(new Animated.Value(0)).current;
  const scroll = useRef<ScrollView>(null);
  const scrollTop = useRef(0);
  const place = placement(menu, 1, area, height);
  const still = reduceMotion() === true;
  const whole = useWholeList();
  useEffect(() => {
    if (leaving || !height) return;
    const run = Animated.timing(appear, {
      toValue: 1,
      duration: anchoredOpen.duration,
      easing: anchoredOpen.easing,
      useNativeDriver: true,
    });
    run.start();
    return () => run.stop();
  }, [height > 0]);
  useEffect(() => {
    if (!onGone) return;
    const run = Animated.timing(appear, {
      toValue: 0,
      ...anchoredClose,
      useNativeDriver: true,
    });
    run.start(() => onGone());
    return () => run.stop();
  }, [leaving]);
  useEffect(() => {
    if (!leaving) setAutofillMenuOffscreen(tabId, menu.seq, place.offscreen);
  }, [place.offscreen]);
  useEffect(() => {
    if (!leaving && !rows.length) closeAutofillMenu(tabId);
  }, [rows.length]);
  const list = rows.filter((r) => r.kind !== "manage");
  const footer = rows.filter((r) => r.kind === "manage");
  const shown = whole ? list : list.slice(0, VAULT_MENU.visibleRows + 1);
  const listRoom = Math.max(VAULT_MENU.minList, Math.min(VAULT_MENU.maxList, place.room - (footer.length ? footerHeight : 0)));
  const offsets = useMemo(() => {
    let at = 0;
    return list.map((r) => (at += rowHeight(r)) - rowHeight(r));
  }, [rows]);
  useEffect(() => {
    if (menu.selected < 0 || menu.selected >= list.length) return;
    const start = offsets[menu.selected]!;
    const end = start + rowHeight(list[menu.selected]!);
    if (start < scrollTop.current) scroll.current?.scrollTo({ y: start, animated: false });
    else if (end > scrollTop.current + listRoom) scroll.current?.scrollTo({ y: end - listRoom, animated: false });
  }, [menu.selected, whole, listRoom, offsets]);
  const touchIDReady = useVaultTouchID();
  const windowId = useTab(tabId, (t) => t?.windowId);
  const inFront = useWindowInFront(windowId);
  const shownSelected = inFront ? menu.selected : -1;
  const selectedRow = rows[shownSelected];
  const touchTarget = leaving || !touchIDReady || menu.hidden || !touchIDGlyphShown(menu.touch) || !isTouchCardRow(selectedRow) ? -1 : shownSelected;
  const touchArmed = touchTarget >= 0 && !menu.busy;
  useEffect(() => {
    armAutofillTouchID(tabId, touchArmed ? menu.seq : null);
    return () => armAutofillTouchID(tabId, null);
  }, [tabId, touchArmed, menu.seq]);
  useEffect(() => {
    const now = autofillMenuOf(tabId);
    if (!leaving && inFront && now && !now.hovered && now.seq === menu.seq) selectAutofillRow(tabId, autofillRestingRow(rows));
  }, [inFront]);
  const touch = { phase: menu.touch, retries: menu.touchRetries };
  const view = (row: AutofillRow, index: number, layer?: RowLayer) => (
    <EntryRow
      key={row.key}
      tabId={tabId}
      row={row}
      selected={shownSelected === index}
      plated={index < list.length}
      layer={layer}
      highlight={highlight}
      touch={index === touchTarget && (layer === "lit" || index >= list.length) ? touch : null}
      busy={menu.busy === row.key}
      reserve={touchIDReady}
      onHover={() => menu.selected !== index && selectAutofillRow(tabId, index)}
    />
  );
  const scale = appear.interpolate({
    inputRange: [0, 1],
    outputRange: [anchoredOpen.fromScale, 1],
  });
  const motion = menu.hidden ? { opacity: 0 } : still ? { opacity: appear } : { opacity: appear, transform: [{ scale }] };
  return (
    <Animated.View
      pointerEvents={menu.hidden || leaving ? "none" : "auto"}
      accessibilityRole="menu"
      accessibilityLabel={menu.kind === "card" ? "Saved Cards" : "Saved Addresses"}
      onMouseEnter={leaving ? undefined : () => hoverAutofillMenu(tabId, true)}
      onMouseLeave={leaving ? undefined : () => hoverAutofillMenu(tabId, false)}
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
      style={{
        position: "absolute",
        left: place.left,
        ...place.anchor,
        width: place.width,
        transformOrigin: place.upward ? "left bottom" : "left top",
        ...motion,
      }}
    >
      <MenuSurface glass={glass}>
        <ScrollView
          ref={scroll}
          style={{ maxHeight: listRoom }}
          contentContainerStyle={LIST}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={(e) => (scrollTop.current = e.nativeEvent.contentOffset.y)}
        >
          {shown.map((row, i) => view(row, i))}
          <SelectionPlate
            index={shownSelected}
            offsets={offsets}
            fill={highlight.fill}
            accessory={
              touchTarget >= 0 ? (
                <VaultTouchID
                  key={menu.touchRearms}
                  armed={touchArmed}
                  grantScope={touchScopeOfAutofill(tabId, selectedRow)}
                  onStatus={(status) => noteAutofillTouchStatus(tabId, menu.seq, status)}
                  style={TOUCH_ID_SIZE}
                />
              ) : null
            }
          >
            {list.map((row, i) => view(row, i, "lit"))}
          </SelectionPlate>
        </ScrollView>
        <Expand open={!!menu.error}>
          <Text size="caption" tone="destructive" lines={2} style={ERROR}>
            {menu.error}
          </Text>
        </Expand>
        {footer.length ? (
          <View style={FOOTER}>
            <Divider style={SEPARATOR} />
            <View style={FOOTER_ROWS}>{footer.map((row, i) => view(row, list.length + i))}</View>
          </View>
        ) : null}
      </MenuSurface>
    </Animated.View>
  );
}

const LIST = {
  paddingTop: VAULT_MENU.listPad,
  paddingBottom: VAULT_MENU.separatorGap,
} as const;
const TOUCH_ID_SIZE = {
  width: VAULT_MENU.touchID,
  height: VAULT_MENU.touchID,
} as const;
const SEPARATOR = { marginHorizontal: VAULT_MENU.separatorInset } as const;
const ERROR = {
  paddingHorizontal: VAULT_MENU.separatorInset,
  paddingBottom: VAULT_MENU.separatorGap,
} as const;
const FOOTER = { paddingBottom: VAULT_MENU.footerBottom } as const;
const FOOTER_ROWS = { paddingTop: VAULT_MENU.separatorGap } as const;
const BADGE_SLOT = {
  width: VAULT_MENU.icon.box,
  alignItems: "center",
} as const;
