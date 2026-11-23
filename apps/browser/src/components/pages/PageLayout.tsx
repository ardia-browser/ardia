import { appUrlOrigin, urlForDisplay } from "@ardia/core";
import { displayHostOf } from "../../lib/url";
import { markHoverProps } from "../../lib/hoverMarks";
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { StyleSheet, View, type TextInput } from "react-native";
import { Box, Button, display, HoverSlot, iconButton, SearchField, space, Text, useOffstage, useTheme, WindowDragRegion } from "../ui";
import { pageHeader, pageToolbar, rowControls } from "./tokens";
import { perLook } from "../ui/tokens";
import { keepActivationKeys } from "./listCursor";

export const PAGE_WIDTH = 880;

type PageToolbarSize = keyof typeof pageToolbar;

export function PageToolbar({ size, divider, drag, children }: { size: PageToolbarSize; divider?: boolean; drag?: boolean; children: ReactNode }) {
  const theme = useTheme();
  const bar = pageToolbar[size];
  return (
    <View
      style={{
        height: bar.height,
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: space[bar.padX],
        gap: space[bar.gap],
        borderTopWidth: divider ? StyleSheet.hairlineWidth * 2 : undefined,
        borderTopColor: divider ? theme.divider : undefined,
      }}
    >
      {drag ? <WindowDragRegion style={StyleSheet.absoluteFill} /> : null}
      {children}
    </View>
  );
}

export function PageHeader({ title, query, onQuery, actions, searchRef, onArrow }: { title: string; query: string; onQuery: (q: string) => void; actions?: ReactNode; searchRef?: Ref<TextInput>; onArrow?: (step: 1 | -1) => void }) {
  return (
    <PageToolbar size="page">
      <Text weight="semibold" style={HEADER_TITLE()}>
        {title}
      </Text>
      <View style={HEADER_SEARCH}>
        <View style={SEARCH_WIDTH}>
          <SearchField value={query} onChangeText={onQuery} placeholder={`Search ${title.toLowerCase()}`} inputRef={searchRef} onArrow={onArrow} />
        </View>
      </View>
      <Box row gap="m" style={HEADER_ACTIONS}>
        {actions}
      </Box>
    </PageToolbar>
  );
}

const HEADER_TITLE = perLook(() => ({ width: pageHeader.sideWidth, ...display.title }) as const);
const HEADER_SEARCH = { flex: 1, alignItems: "center" } as const;
const SEARCH_WIDTH = { width: "100%", maxWidth: pageHeader.searchMaxWidth } as const;
const HEADER_ACTIONS = { width: pageHeader.sideWidth, justifyContent: "flex-end", alignItems: "center" } as const;

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function RowMenuSlot({ shown, onPress }: { shown: boolean; onPress: () => void }) {
  return <HoverSlot hovered={shown} width={iconButton.l.box} hover={<View onKeyDown={keepActivationKeys}><Button variant="icon" icon="ellipsis" size="l" focusable onPress={onPress} tooltip="More actions" /></View>} />;
}

const pageScroll = { lastAt: 0 };

export function notePageScroll() {
  pageScroll.lastAt = Date.now();
}

export function useFocusWithin(key: string) {
  const latest = useRef(key);
  latest.current = key;
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [focusProps] = useState(() => {
    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    return {
      onFocus: () => {
        clearTimeout(blurTimer);
        setFocusedKey(latest.current);
      },
      onBlur: () => {
        clearTimeout(blurTimer);
        blurTimer = setTimeout(() => setFocusedKey(null), 0);
      },
    };
  });
  return { focused: focusedKey === key, focusProps };
}

export function useRowControls(key: string, keyboardRow = false) {
  const offstage = useOffstage();
  const latest = useRef({ key, offstage });
  latest.current = { key, offstage };
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [restingKey, setRestingKey] = useState<string | null>(null);
  const { focused, focusProps } = useFocusWithin(key);
  const [hoverProps] = useState(() => {
    const rest = (hoveredRow: string) => {
      const wait = pageScroll.lastAt + rowControls.scrollSettleMs - Date.now();
      if (wait <= 0) setRestingKey(hoveredRow);
      else settle.current = setTimeout(() => rest(hoveredRow), wait);
    };
    return markHoverProps({
      onMouseEnter: () => {
        clearTimeout(settle.current);
        if (latest.current.offstage) return;
        setHoveredKey(latest.current.key);
        rest(latest.current.key);
      },
      onMouseLeave: () => {
        clearTimeout(settle.current);
        setHoveredKey(null);
        setRestingKey(null);
      },
    });
  });
  useEffect(() => () => clearTimeout(settle.current), []);
  const hovered = !offstage && hoveredKey === key;
  const rowProps = useMemo(() => ({ ...hoverProps, ...focusProps }), [hoverProps, focusProps]);
  return { hovered, controlsShown: (hovered && restingKey === key) || focused || keyboardRow, rowProps };
}

export const dayStart =(ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

export function dayLabel(start: number, now = Date.now()): string {
  const d = new Date(start);
  const full = `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  const today = dayStart(now);
  if (start === today) return `Today – ${full}`;
  if (start === dayStart(today - 1)) return `Yesterday – ${full}`;
  return full;
}

export function timeLabel(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export const hostLabel = (url: string) => appUrlOrigin(url) || displayHostOf(url) || url;

export const queryWords = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

export const searchText = (...fields: string[]) => fields.map((f) => (/xn--/i.test(f) ? `${f} ${urlForDisplay(f)}` : f)).join(" ").toLowerCase();

export function matchesQuery(query: string, ...fields: string[]): boolean {
  const words = queryWords(query);
  if (!words.length) return true;
  const hay = searchText(...fields);
  return words.every((w) => hay.includes(w));
}
