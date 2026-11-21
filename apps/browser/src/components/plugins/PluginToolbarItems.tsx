import { useLayoutEffect, useRef } from "react";
import { Pressable, View } from "react-native";
import type { Tone, ToolbarUpdate } from "../../lib/pluginProtocol";
import { toolbarBadgeText } from "../../lib/toolbarBadge";
import { runPluginToolbarItem, type PluginToolbarEntry } from "../../state/plugins/actions";
import { usePluginPopover, usePluginToolbarItems, usePluginWindowEligible } from "../../state/plugins/hooks";
import { Badge, Button, Dot, Text, useTheme, useToolbarRowContext, type ColorRole } from "../ui";
import type { ToolbarPalette } from "../ui/toolbarColors";
import { BADGE_PLACE, LABEL_PILL_RADIUS, TOOLBAR_ITEM } from "./tokens";

const TONE_ROLE: Record<Tone, ColorRole | null> = { default: null, secondary: null, tertiary: null, accent: "accent", success: "success", warning: "warning", destructive: "destructive" };

const labelOf = (state: ToolbarUpdate) => (typeof state.label === "string" && state.label ? state.label : null);
const labelWidth = (label: string) => Math.min(TOOLBAR_ITEM.labelMax, Math.ceil(label.length * TOOLBAR_ITEM.labelChar) + TOOLBAR_ITEM.labelPad * 2);

function itemsWidth(items: readonly PluginToolbarEntry[], button: number): number {
  if (!items.length) return 0;
  const total = items.reduce((sum, item) => {
    const label = labelOf(item.state);
    return sum + button + (label ? labelWidth(label) + TOOLBAR_ITEM.gap * 2 : 0) + TOOLBAR_ITEM.gap;
  }, 0);
  return total - TOOLBAR_ITEM.gap + TOOLBAR_ITEM.edge;
}

export function PluginToolbarItems({ windowId, palette, top, right, onWidth }: { windowId: string; palette: ToolbarPalette; top: number; right: number; onWidth: (width: number) => void }) {
  const eligible = usePluginWindowEligible(windowId);
  const items = usePluginToolbarItems();
  const button = useToolbarRowContext().extensionButton || TOOLBAR_ITEM.button;
  const width = eligible ? itemsWidth(items, button) : 0;
  useLayoutEffect(() => onWidth(width), [onWidth, width]);
  useLayoutEffect(() => () => onWidth(0), [onWidth]);
  if (!width) return null;
  return (
    <View style={{ position: "absolute", top, right, flexDirection: "row", alignItems: "center", gap: TOOLBAR_ITEM.gap }}>
      {items.map((item) => (
        <ToolbarItemButton key={item.key} windowId={windowId} item={item} palette={palette} />
      ))}
    </View>
  );
}

function ToolbarItemButton({ windowId, item, palette }: { windowId: string; item: PluginToolbarEntry; palette: ToolbarPalette }) {
  const theme = useTheme();
  const ref = useRef<View>(null);
  const popover = usePluginPopover(windowId);
  const open = popover?.plugin === item.plugin && popover.itemId === item.id;
  const button = useToolbarRowContext().extensionButton || TOOLBAR_ITEM.button;
  const { state } = item;
  const role = state.tone ? TONE_ROLE[state.tone] : null;
  const label = labelOf(state);
  const icon = state.icon || item.icon || "puzzlepiece";
  const tooltip = state.tooltip ?? item.tooltip ?? item.title;
  const press = () => {
    const view = ref.current;
    const fallback = { x: 0, y: 0, width: button, height: button };
    if (!view) return void runPluginToolbarItem(windowId, item.plugin, item.id, fallback);
    view.measureInWindow((x, y, width, height) => void runPluginToolbarItem(windowId, item.plugin, item.id, { x, y, width, height }));
  };
  const badge = badgeOf(state.badge, role ? theme[role] : theme.destructive, theme.onAccent);
  return (
    <View ref={ref} collapsable={false} style={ROW}>
      <Button
        variant="icon"
        look="extension"
        palette={palette}
        active={open}
        tooltip={tooltip}
        icon={icon}
        glyph={TOOLBAR_ITEM.glyph}
        glyphBox={TOOLBAR_ITEM.glyphBox}
        color={role ? theme[role] : undefined}
        onPress={press}
        badge={badge}
      />
      {label ? (
        <Pressable onPress={press} style={[LABEL, { width: labelWidth(label), backgroundColor: palette.pill }]}>
          <Text size="caption" weight="medium" numberOfLines={1} color={role ? theme[role] : palette.text}>
            {label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function badgeOf(value: ToolbarUpdate["badge"], fill: string, ink: string) {
  if (value === undefined || value === null || value === false || value === "" || value === 0) return null;
  if (value === true) return <Dot size={TOOLBAR_ITEM.dot} color={fill} style={DOT_PLACE} />;
  return <Badge text={toolbarBadgeText(value)} size="s" fill={fill} color={ink} style={BADGE_PLACE} />;
}

const ROW = { flexDirection: "row", alignItems: "center" } as const;
const LABEL = { marginLeft: TOOLBAR_ITEM.gap * 2, height: TOOLBAR_ITEM.glyphBox, justifyContent: "center", alignItems: "center", paddingHorizontal: TOOLBAR_ITEM.labelPad, borderRadius: LABEL_PILL_RADIUS } as const;
const DOT_PLACE = { position: "absolute", right: TOOLBAR_ITEM.labelPad, top: TOOLBAR_ITEM.labelPad } as const;
