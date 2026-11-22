import { useState } from "react";
import { Pressable, View } from "react-native";
import type { PluginNode } from "../../lib/pluginProtocol";
import { ActivitySpinner, Badge, Box, ContextMenuArea, layout, ListRow, Symbol, Text, useTheme } from "../ui";
import { ActionMenuButton, useActionMenu } from "./SurfaceActions";
import { Children, SurfaceIcon } from "./SurfaceBasics";
import { SURFACE } from "./tokens";
import { actionsIn, bool, fillToneOf, isHandlerRef, str, toneOf, useSurface } from "./surfaceNodes";

export function SidebarViewNode({ node }: { node: PluginNode }) {
  const p = node.props;
  const title = str(p.title);
  return (
    <Box gap="xxs">
      {title || bool(p.isLoading) || actionsIn(p.actions).length ? (
        <Box row gap="s" padX="m" style={HEADER}>
          {title ? <Text size="small" weight="semibold" tone="textSecondary" numberOfLines={1} style={FLEX}>{title}</Text> : <View style={FLEX} />}
          {bool(p.isLoading) ? <ActivitySpinner style={SPINNER} /> : null}
          <ActionMenuButton panel={p.actions} />
        </Box>
      ) : null}
      <Children node={node} />
    </Box>
  );
}

export function SidebarSectionNode({ node }: { node: PluginNode }) {
  const theme = useTheme();
  const p = node.props;
  const collapsible = p.collapsible !== false && !!str(p.title);
  const [collapsed, setCollapsed] = useState(bool(p.defaultCollapsed));
  const title = str(p.title);
  return (
    <Box gap="xxs">
      {title ? (
        <Box row gap="xs" padX="m" style={HEADER}>
          <Pressable disabled={!collapsible} onPress={() => setCollapsed((c) => !c)} style={TITLE_PRESS}>
            {collapsible ? <Symbol name={collapsed ? "chevron.right" : "chevron.down"} size={SURFACE.chevron} weight="semibold" color={theme.textTertiary} style={CHEVRON} /> : null}
            <Text size="small" weight="semibold" tone="textSecondary" numberOfLines={1}>{title}</Text>
          </Pressable>
          <ActionMenuButton panel={p.actions} />
        </Box>
      ) : null}
      {collapsed ? null : <Children node={node} />}
    </Box>
  );
}

export function SidebarItemNode({ node, depth = 0 }: { node: PluginNode; depth?: number }) {
  const theme = useTheme();
  const { fire, render } = useSurface();
  const menu = useActionMenu();
  const p = node.props;
  const nested = node.children.filter((c): c is PluginNode => typeof c !== "string" && c.type === "SidebarItem");
  const others = node.children.filter((c) => typeof c === "string" || c.type !== "SidebarItem");
  const [open, setOpen] = useState(true);
  const badge = str(p.badge);
  const role = fillToneOf(p.tone);
  const subtitle = str(p.subtitle);
  return (
    <View>
      <ContextMenuArea onContextMenu={actionsIn(p.actions).length ? () => void menu(p.actions) : undefined}>
        <ListRow selected={bool(p.selected)} height={layout.rowHeight} onPress={() => (isHandlerRef(p.onPress) ? fire(p.onPress) : nested.length ? setOpen((o) => !o) : undefined)}>
          <View style={{ width: depth * SURFACE.indent }} />
          {nested.length ? (
            <Pressable onPress={() => setOpen((o) => !o)}>
              <Symbol name={open ? "chevron.down" : "chevron.right"} size={SURFACE.chevron} weight="semibold" color={theme.textTertiary} style={CHEVRON} />
            </Pressable>
          ) : null}
          <SurfaceIcon name={str(p.icon)} tone={p.tone} />
          <Box row gap="s" style={[FLEX, CENTER]}>
            <Text numberOfLines={1} tone={role ? toneOf(p.tone) : "textPrimary"} style={SHRINK}>{str(p.title) ?? ""}</Text>
            {subtitle ? <Text size="small" tone="textTertiary" numberOfLines={1} style={SHRINK}>{subtitle}</Text> : null}
          </Box>
          {badge ? <Badge text={badge} size="s" fill={role ? theme[role] : undefined} color={role ? theme.onAccent : undefined} tone="chip" /> : null}
        </ListRow>
      </ContextMenuArea>
      {others.length ? <View style={{ paddingLeft: (depth + 1) * SURFACE.indent }}>{others.map(render)}</View> : null}
      {open ? nested.map((child, index) => <SidebarItemNode key={child.key !== undefined ? String(child.key) : index} node={child} depth={depth + 1} />) : null}
    </View>
  );
}

const FLEX = { flex: 1 } as const;
const SHRINK = { flexShrink: 1 } as const;
const CENTER = { alignItems: "center" } as const;
const HEADER = { alignItems: "center", minHeight: SURFACE.rowHeight } as const;
const TITLE_PRESS = { flex: 1, flexDirection: "row", alignItems: "center", gap: SURFACE.chevron / 2 } as const;
const CHEVRON = { width: SURFACE.iconBox / 1.5, height: SURFACE.iconBox } as const;
const SPINNER = { width: SURFACE.spinner, height: SURFACE.spinner } as const;
