import { memo } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View, type TextStyle } from "react-native";
import { queryPrefixLength, type TrayRow } from "../../state/search/omnibox";
import { countRender } from "../../state/app/interactionPerf";
import type { Design } from "../../lib/design";
import { browseLayout, Favicon, font, radius, screenReaderActions, space, Symbol, tabsMotion, useDesign, type ColorRoles, type SymbolName } from "../ui";
import type { Point } from "../../lib/menuPlace";

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
};

const LEADING: Record<TrayRow["kind"], SymbolName> = { query: "magnifyingglass", page: "globe", calc: "equalCircleFill", paste: "docOnDoc", browseForMe: "sparkleMagnifyingglass" };

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
  const content = <RowContent row={row} typed={typed} roles={roles} interactive={interactive} onRefine={onRefine} />;
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
        style={styles.row}
      >
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onActivate(row)}
      onLongPress={(event) => onMenu(row, { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY })}
      delayLongPress={tabsMotion.longPress}
      {...screenReaderActions(menuActions)}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed && highlightsPress ? roles.rowHighlight : undefined }]}
    >
      {content}
    </Pressable>
  );
});

const MENU_ACTION = "menu";

const LARGE_TEXT = 1.5;

function RowContent({ row, typed, roles, interactive, onRefine }: { row: TrayRow; typed: string; roles: ColorRoles; interactive: boolean; onRefine: (row: TrayRow) => void }) {
  const design = useDesign();
  const look = ROW_LOOK[design];
  const large = useWindowDimensions().fontScale > LARGE_TEXT;
  return (
    <>
      <View style={styles.leading}>
        {row.kind === "page" ? <Favicon iconUrl={row.favicon} pageUrl={row.url} size={look.favicon} /> : <Symbol name={row.kind === "paste" && row.offer === "link" ? "link" : LEADING[row.kind]} size={look.glyph} color={roles.rowIcon} />}
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
      {row.kind === "query" && design === "original" ? (
        interactive ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`Refine ${row.title}`} onPress={() => onRefine(row)} style={styles.refine}>
            <View style={styles.refineGlyph}>
              <Symbol name="arrowUpForward" size={15} color={roles.rowIcon} />
            </View>
          </Pressable>
        ) : (
          <View style={styles.refine}>
            <View style={styles.refineGlyph}>
              <Symbol name="arrowUpForward" size={15} color={roles.rowIcon} />
            </View>
          </View>
        )
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
  leading: { width: browseLayout.suggestionIconSlot, height: browseLayout.suggestionIconSlot, alignItems: "center", justifyContent: "center" },
  label: { flex: 1, gap: space.hair },
  detail: { flexDirection: "row", alignItems: "center", gap: space.xs },
  detailText: { flexShrink: 1 },
  refine: { width: browseLayout.refineWidth, height: browseLayout.suggestionPitch, alignItems: "center", justifyContent: "center" },
  refineGlyph: { transform: [{ rotate: "-90deg" }] },
});
