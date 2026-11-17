import { useEffect, useRef, useState, type RefObject } from "react";
import { BackHandler, Pressable, StyleSheet, Text, View, type ViewStyle, type ViewInstance } from "react-native";
import { MENU_ROW, menuHeight, menuTop } from "../../lib/menuPlace";
import { useCoverFocus } from "./coverFocus";
import { measureAnchor, Portal, useOverlayFrame, type WindowRect } from "./Overlay";
import Animated, { FadeIn } from "react-native-reanimated";
import { tabsMotion } from "./motion";
import { Symbol } from "./Symbol";
import type { SymbolName } from "./symbolPaths";
import { useTheme } from "./theme";
import { font, ink, menuShadow, radius, space, tabsLayout } from "./tokens";

export type MenuAction = { label: string; icon?: SymbolName; systemImage?: string; destructive?: boolean; checked?: boolean; disabled?: boolean; onPress: () => void };

export type MenuSubmenu = { label: string; icon?: SymbolName; systemImage?: string; disabled?: boolean; children: MenuItem[] };

export type MenuItem = MenuAction | MenuSubmenu | "divider" | { heading: string };

export const isSubmenu = (item: MenuAction | MenuSubmenu): item is MenuSubmenu => "children" in item;

export const submenuPage = (submenu: MenuSubmenu): MenuItem[] => [{ heading: submenu.label }, ...submenu.children];

type Props = { items: MenuItem[]; place: ViewStyle; onDismiss: () => void };

export function Menu({ items, place, onDismiss }: Props) {
  const theme = useTheme();
  const [page, setPage] = useState<MenuSubmenu | null>(null);
  const shown = page ? submenuPage(page) : items;
  const panel = useRef<ViewInstance>(null);
  useCoverFocus(panel);
  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      onDismiss();
      return true;
    });
    return () => back.remove();
  }, [onDismiss]);
  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable accessibilityLabel="Dismiss" style={[StyleSheet.absoluteFill, { backgroundColor: ink.clear }]} onPress={onDismiss} />
      <Animated.View
        ref={panel}
        accessibilityViewIsModal
        entering={FadeIn.duration(tabsMotion.menu)}
        style={[styles.panel, place, { backgroundColor: theme.panel, borderColor: theme.controlEdge, shadowColor: theme.trayShadow }]}
      >
        {shown.map((item, index) => {
          if (item === "divider") return <View key={`d${index}`} style={[styles.divider, { backgroundColor: theme.divider }]} />;
          if ("heading" in item)
            return (
              <Text key={`h${index}`} style={[font.footnote, styles.heading, { color: theme.secondaryLabel }]}>
                {item.heading}
              </Text>
            );
          if (isSubmenu(item))
            return (
              <Pressable
                key={`${index}:${item.label}`}
                accessibilityRole="menuitem"
                accessibilityLabel={item.label}
                accessibilityState={{ disabled: item.disabled, expanded: false }}
                disabled={item.disabled}
                onPress={() => setPage(item)}
                style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.rowHighlight } : null, item.disabled ? styles.disabled : null]}
              >
                <Text style={[font.body, styles.label, { color: theme.label }]}>{item.label}</Text>
                <Symbol name={item.icon ?? "chevronRight"} size={18} color={theme.label} />
              </Pressable>
            );
          const color = item.destructive ? theme.destructive : theme.label;
          return (
            <Pressable
              key={`${index}:${item.label}`}
              accessibilityRole="menuitem"
              accessibilityLabel={item.label}
              accessibilityState={{ checked: item.checked, disabled: item.disabled }}
              disabled={item.disabled}
              onPress={() => {
                onDismiss();
                item.onPress();
              }}
              style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.rowHighlight } : null, item.disabled ? styles.disabled : null]}
            >
              <Text style={[font.body, styles.label, { color }]}>{item.label}</Text>
              {item.checked ? <Symbol name="checkmark" size={18} color={theme.formAccent} /> : null}
              {item.icon ? <Symbol name={item.icon} size={18} color={color} /> : null}
            </Pressable>
          );
        })}
      </Animated.View>
    </View>
  );
}

const MENU_MARGIN = 8;

function centredOn(row: WindowRect, host: WindowRect, across: ViewStyle): ViewStyle {
  if (across.left !== undefined || across.right !== undefined) return {};
  const width = typeof across.width === "number" ? across.width : tabsLayout.menuWidth;
  const left = row.x - host.x + row.width / 2 - width / 2;
  return { width, left: Math.max(MENU_MARGIN, Math.min(left, host.width - width - MENU_MARGIN)) };
}

export function FloatingMenu({ items, place, onDismiss, anchor }: Props & { anchor?: RefObject<ViewInstance | null> }) {
  const hostFrame = useOverlayFrame();
  const [placed, setPlaced] = useState<ViewStyle | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([hostFrame(), anchor ? measureAnchor(anchor) : Promise.resolve(null)]).then(([host, row]) => {
      if (!live) return;
      if (row && row.height > 0) {
        const { top: _top, bottom: _bottom, ...across } = place;
        setPlaced({ ...across, ...centredOn(row, host, across), top: menuTop(row, host, menuHeight(items), MENU_MARGIN) });
      } else if (typeof place.top === "number") {
        setPlaced({ ...place, top: Math.max(MENU_MARGIN, Math.min(place.top - host.y, host.height - menuHeight(items) - MENU_MARGIN)) });
      } else setPlaced(place);
    });
    return () => {
      live = false;
    };
  }, []);
  return placed ? (
    <Portal>
      <Menu items={items} place={placed} onDismiss={onDismiss} />
    </Portal>
  ) : null;
}

const styles = StyleSheet.create({
  panel: {
    position: "absolute",
    minWidth: 230,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: space.xs,
    elevation: 12,
    shadowOpacity: menuShadow.opacity,
    shadowRadius: menuShadow.radius,
    shadowOffset: { width: 0, height: menuShadow.offsetY },
  },
  row: { flexDirection: "row", alignItems: "center", gap: space.m, paddingHorizontal: space.l, minHeight: MENU_ROW },
  label: { flex: 1 },
  heading: { paddingHorizontal: space.l, paddingVertical: space.xs + 2 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: space.xs },
  disabled: { opacity: 0.4 },
});
