import { memo } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View, type TextStyle } from "react-native";
import { Pressable as GesturePressable } from "react-native-gesture-handler";
import { queryPrefixLength, type TrayRow } from "../../state/search/omnibox";
import { countRender } from "../../state/app/interactionPerf";
import type { Design } from "../../lib/design";
import type { Point } from "../../lib/menuPlace";
import { browseLayout, Favicon, font, MaterialIconButton, radius, screenReaderActions, space, Symbol, tabsMotion, useDesign, type ColorRoles, type SymbolName, Tappable } from "../ui";
import { useMaterialRipple } from "../ui/MaterialSurfaces";
import { materialBottomBar, materialSize, materialType } from "../ui/materialTokens";
import { searchPanel } from "./searchPanelTokens";

const MATERIAL_ROW_ICON = 20;

const ROW_LOOK: Record<Design, { glyph: number; favicon: number; switchGlyph: boolean; title3: TextStyle; body: TextStyle; subheadline: TextStyle }> = {
  original: { glyph: 19, favicon: 20, switchGlyph: true, title3: font.title3, body: font.body, subheadline: font.subheadline },
  redesigned: {
    glyph: 25,
    favicon: browseLayout.suggestionIconSlot * 0.82,
    switchGlyph: false,
    title3: { fontSize: font.title3.fontSize },
    body: { fontSize: font.body.fontSize },
    subheadline: { fontSize: font.subheadline.fontSize },
  },
  material: { glyph: MATERIAL_ROW_ICON, favicon: MATERIAL_ROW_ICON, switchGlyph: false, title3: materialType.bodyLarge, body: materialType.bodyLarge, subheadline: materialType.bodySmall },
};

const LEADING: Record<TrayRow["kind"], SymbolName> = { query: "magnifyingglass", page: "globe", calc: "equalCircleFill", paste: "docOnDoc", browseForMe: "sparkleMagnifyingglass" };

const leadingSymbol = (row: TrayRow): SymbolName => (row.kind === "paste" && row.offer === "link" ? "link" : row.kind === "query" && row.past ? "clockArrow" : LEADING[row.kind]);

type Props = {
  row: TrayRow;
  typed: string;
  roles: ColorRoles;
  interactive?: boolean;
  highlightsPress?: boolean;
  menu?: readonly { label: string; run: () => void }[];
  onActivate: (row: TrayRow) => void;
  onRefine: (row: TrayRow) => void;
  onMenu: (row: TrayRow, at: Point) => void;
};

export const SuggestionRow = memo(function SuggestionRow({ row, typed, roles, interactive = true, highlightsPress = true, menu = [], onActivate, onRefine, onMenu }: Props) {
  countRender("SuggestionRow");
  const design = useDesign();
  const material = design === "material";
  const ripple = useMaterialRipple();
  const twoLine = row.kind !== "query" || Boolean(row.detail);
  const panel = design === "redesigned";
  const rowStyle = material ? [styles.materialRow, twoLine ? styles.materialRowTwoLine : null] : panel ? styles.panelRow : styles.row;
  const content = panel ? <PanelRowContent row={row} typed={typed} roles={roles} /> : <RowContent row={row} typed={typed} roles={roles} interactive={interactive} onRefine={onRefine} />;
  const menuActions = menu.map((item, index) => ({ name: `${MENU_ACTION}${index}`, label: item.label, run: item.run }));
  if (!interactive) {
    const actions = [
      { name: "activate", run: () => onActivate(row) },
      ...(row.kind === "query" ? [{ name: "refine", label: `Refine ${row.title}`, run: () => onRefine(row) }] : []),
      ...menuActions,
    ];
    return (
      <View
        accessible
        accessibilityRole="button"
        {...screenReaderActions(actions)}
        style={rowStyle}
      >
        {content}
      </View>
    );
  }
  const RowPressable = material ? GesturePressable : Pressable;
  return (
    <RowPressable
      accessibilityRole="button"
      android_ripple={material ? ripple : undefined}
      onPress={() => onActivate(row)}
      onLongPress={(event: { nativeEvent: { pageX: number; pageY: number } }) => onMenu(row, { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY })}
      delayLongPress={tabsMotion.longPress}
      {...screenReaderActions(menuActions)}
      style={({ pressed }) => [rowStyle, !material && pressed && highlightsPress ? { backgroundColor: roles.rowHighlight } : null]}
    >
      {content}
    </RowPressable>
  );
});

const MENU_ACTION = "menu";

const LARGE_TEXT = 1.5;

function RowContent({ row, typed, roles, interactive, onRefine }: { row: TrayRow; typed: string; roles: ColorRoles; interactive: boolean; onRefine: (row: TrayRow) => void }) {
  const design = useDesign();
  const material = design === "material";
  const look = ROW_LOOK[design];
  const large = useWindowDimensions().fontScale > LARGE_TEXT;
  return (
    <>
      <View testID={material ? "materialSearchIconSlot" : undefined} style={material ? styles.materialLeading : styles.leading}>
        {row.kind === "page" ? <Favicon iconUrl={row.favicon} pageUrl={row.url} size={look.favicon} /> : <Symbol name={leadingSymbol(row)} size={look.glyph} color={roles.rowIcon} />}
      </View>
      <View style={styles.label}>
        {row.kind === "query" ? (
          <>
            <QueryTitle title={row.title} typed={typed} roles={roles} lines={large ? 4 : 2} style={look.title3} />
            {row.detail ? (
              <Text style={[look.subheadline, { color: roles.foregroundSecondary }]} numberOfLines={1}>
                {row.detail}
              </Text>
            ) : null}
          </>
        ) : (
          <>
            <Text style={[look.body, { color: roles.foregroundPrimary }]} numberOfLines={large ? 3 : 1}>
              {row.title}
            </Text>
            <View style={styles.detail}>
              {row.kind === "page" && row.switchesTab && look.switchGlyph ? <Symbol name="arrowRightCircle" size={13} color={roles.foregroundSecondary} /> : null}
              {row.kind === "page" && row.fromMac ? <Symbol name="laptop" size={13} color={roles.foregroundSecondary} /> : null}
              <Text style={[look.subheadline, styles.detailText, { color: roles.foregroundSecondary }]} numberOfLines={1}>
                {row.detail}
              </Text>
            </View>
          </>
        )}
      </View>
      {row.kind === "query" && (design === "original" || material) ? (
        interactive ? (
          material ? (
            <MaterialIconButton
              icon="arrowUpForward"
              iconSize={15}
              iconStyle={styles.refineGlyph}
              label={`Refine ${row.title}`}
              ink={roles.rowIcon}
              size="compact"
              onPress={() => onRefine(row)}
            />
          ) : (
            <Tappable kind="icon" label={`Refine ${row.title}`} onPress={() => onRefine(row)} style={styles.refine}>
              <View style={styles.refineGlyph}>
                <Symbol name="arrowUpForward" size={15} color={roles.rowIcon} />
              </View>
            </Tappable>
          )
        ) : (
          <View style={material ? styles.materialRefine : styles.refine}>
            <View style={styles.refineGlyph}>
              <Symbol name="arrowUpForward" size={15} color={roles.rowIcon} />
            </View>
          </View>
        )
      ) : null}
    </>
  );
}

const PANEL_TRAILING: Partial<Record<TrayRow["kind"], true>> = { calc: true, paste: true, browseForMe: true };

export const panelTitleLines = (fontScale: number) => (fontScale > LARGE_TEXT ? 3 : 1);

function PanelRowContent({ row, typed, roles }: { row: TrayRow; typed: string; roles: ColorRoles }) {
  const lines = panelTitleLines(useWindowDimensions().fontScale);
  const detail = row.kind === "query" ? row.detail : row.kind === "page" ? (row.switchesTab ? row.detail : null) : PANEL_TRAILING[row.kind] ? row.detail : null;
  const fromMac = row.kind === "page" && !row.switchesTab ? (row.fromMac ?? null) : null;
  return (
    <>
      <View style={styles.panelLeading}>
        {row.kind === "page" ? <Favicon iconUrl={row.favicon} pageUrl={row.url} size={searchPanel.iconSlot} /> : <Symbol name={leadingSymbol(row)} size={searchPanel.glyph} color={roles.rowIcon} />}
      </View>
      <View style={styles.panelLabel}>
        {row.kind === "query" ? (
          <QueryTitle title={row.title} typed={typed} roles={roles} lines={lines} style={styles.panelTitleText} />
        ) : (
          <Text style={[styles.panelTitleText, { color: roles.foregroundPrimary }]} numberOfLines={lines}>
            {row.title}
          </Text>
        )}
        {detail ? (
          <Text style={[styles.panelDetail, { color: roles.foregroundSecondary }]} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {fromMac ? (
        <View testID="panelRowFromMac" accessible accessibilityLabel={fromMac} style={styles.panelTrailing}>
          <Symbol name="laptop" size={searchPanel.trailingGlyph} color={roles.rowIcon} />
        </View>
      ) : null}
    </>
  );
}

function QueryTitle({ title, typed, roles, lines, style }: { title: string; typed: string; roles: ColorRoles; lines: number; style: TextStyle }) {
  const prefix = queryPrefixLength(title, typed);
  return (
    <Text style={[style, { color: roles.foregroundPrimary }]} numberOfLines={lines}>
      {prefix > 0 ? <Text style={{ color: roles.foregroundSecondary }}>{title.slice(0, prefix)}</Text> : null}
      {title.slice(prefix)}
    </Text>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: browseLayout.suggestionPitch,
    flexDirection: "row",
    alignItems: "center",
    gap: space.m,
    paddingLeft: browseLayout.rowLeading,
    paddingRight: browseLayout.rowTrailing,
    borderRadius: radius.row,
  },
  panelRow: {
    minHeight: searchPanel.rowPitch,
    flexDirection: "row",
    alignItems: "center",
    gap: searchPanel.iconGap,
    paddingLeft: searchPanel.rowLeading,
    paddingRight: searchPanel.rowTrailing,
    borderRadius: radius.row,
    borderCurve: "continuous",
  },
  panelLeading: { width: searchPanel.iconSlot, height: searchPanel.iconSlot, alignItems: "center", justifyContent: "center" },
  panelLabel: { flex: 1, flexDirection: "row", alignItems: "baseline", gap: space.s },
  panelTitleText: { flexShrink: 1, fontSize: searchPanel.titleSize },
  panelDetail: { flexShrink: 2, fontSize: searchPanel.detailSize },
  panelTrailing: { width: searchPanel.trailingGlyph + space.xs, alignItems: "center", justifyContent: "center" },
  materialRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: materialBottomBar.field,
    paddingLeft: 14,
    paddingRight: 4,
    paddingVertical: 6,
  },
  materialRowTwoLine: {
    minHeight: materialSize.listItemOneLine,
  },
  leading: { width: browseLayout.suggestionIconSlot, height: browseLayout.suggestionIconSlot, alignItems: "center", justifyContent: "center" },
  materialLeading: { width: MATERIAL_ROW_ICON, height: MATERIAL_ROW_ICON, alignItems: "center", justifyContent: "center" },
  label: { flex: 1, gap: space.hair },
  detail: { flexDirection: "row", alignItems: "center", gap: space.xs },
  detailText: { flexShrink: 1 },
  refine: { width: browseLayout.refineWidth, height: browseLayout.suggestionPitch, alignItems: "center", justifyContent: "center" },
  materialRefine: { width: materialSize.iconButton, height: materialSize.iconButton, alignItems: "center", justifyContent: "center" },
  refineGlyph: { transform: [{ rotate: "-90deg" }] },
});

export const panelRowLayout = { row: styles.panelRow, leading: styles.panelLeading, title: styles.panelTitleText } as const;
