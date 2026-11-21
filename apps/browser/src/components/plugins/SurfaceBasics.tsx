import { useMemo, type ReactNode } from "react";
import { Pressable, ScrollView, View, type ViewStyle } from "react-native";
import type { PluginNode } from "../../lib/pluginProtocol";
import { ActivitySpinner, Badge, Box, Button, Divider, EmptyState, monoFace, ProgressTrack, space, Symbol, Text, useTheme } from "../ui";
import { ActionButtons, useRunAction, WithShortcutHint } from "./SurfaceActions";
import { PluginFileView } from "./PluginFileView";
import { SurfaceMarkdown } from "./SurfaceMarkdown";
import { SURFACE } from "./tokens";
import { bool, fillToneOf, isHandlerRef, isNode, num, pluginFileUrl, sizeOf, spaceOf, str, textOf, toneOf, useSurface } from "./surfaceNodes";
import { panelShortcuts, shortcutHint, useShortcutRegistration } from "./surfaceShortcuts";

type NodeProps = { node: PluginNode };

const ALIGN: Record<string, ViewStyle["alignItems"]> = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" };
const JUSTIFY: Record<string, ViewStyle["justifyContent"]> = { start: "flex-start", center: "center", end: "flex-end", between: "space-between" };
const FILLS = { subtle: "chipFill", raised: "panel", accent: "accent" } as const;

export function Children({ node }: NodeProps) {
  const { render } = useSurface();
  return <>{node.children.map(render)}</>;
}

export function BoxNode({ node }: NodeProps) {
  const { fire } = useSurface();
  const p = node.props;
  const radiusSpace = spaceOf(p.radius);
  const fill = FILLS[str(p.background) as keyof typeof FILLS];
  const layout: ViewStyle = {
    alignItems: ALIGN[str(p.align) ?? ""],
    justifyContent: JUSTIFY[str(p.justify) ?? ""],
    flexWrap: bool(p.wrap) ? "wrap" : undefined,
    flexGrow: bool(p.grow) ? 1 : undefined,
    borderRadius: radiusSpace ? space[radiusSpace] : undefined,
    overflow: radiusSpace ? "hidden" : undefined,
  };
  const box = (
    <Box row={p.direction === "row"} gap={spaceOf(p.gap)} pad={spaceOf(p.padding)} padX={spaceOf(p.paddingX)} padY={spaceOf(p.paddingY)} fill={fill} style={layout}>
      <Children node={node} />
    </Box>
  );
  if (!isHandlerRef(p.onPress)) return box;
  return <Pressable onPress={() => fire(p.onPress)}>{box}</Pressable>;
}

export function TextNode({ node }: NodeProps) {
  const { render } = useSurface();
  const p = node.props;
  const weight = str(p.weight);
  return (
    <Text
      size={sizeOf(p.size)}
      tone={toneOf(p.tone)}
      weight={weight === "medium" || weight === "semibold" || weight === "bold" || weight === "regular" ? weight : undefined}
      lines={num(p.lines)}
      selectable={bool(p.selectable)}
      style={[{ textAlign: p.align === "center" ? "center" : p.align === "end" ? "right" : undefined }, bool(p.monospace) ? monoFace() : null]}
    >
      {node.children.map(render)}
    </Text>
  );
}

export function MarkdownNode({ node }: NodeProps) {
  const source = str(node.props.markdown) ?? textOf(node.children);
  return source ? <SurfaceMarkdown source={source} /> : null;
}

export function BadgeNode({ node }: NodeProps) {
  const theme = useTheme();
  const role = fillToneOf(node.props.tone);
  const text = textOf(node.children) || str(node.props.text) || "";
  if (!text) return null;
  return role ? <Badge text={text} fill={theme[role]} color={theme.onAccent} /> : <Badge text={text} tone={node.props.tone === "accent" ? "accent" : "chip"} />;
}

export function ButtonNode({ node }: NodeProps) {
  const { fire } = useSurface();
  const p = node.props;
  const loading = bool(p.loading);
  const kind = p.tone === "destructive" ? "destructive" : p.variant === "primary" ? "primary" : p.variant === "plain" ? "plain" : "default";
  return (
    <Box row gap="xs" style={CENTER_ROW}>
      {loading ? <ActivitySpinner style={SPINNER} /> : null}
      <Button title={str(p.title) ?? textOf(node.children) ?? ""} icon={str(p.icon)} kind={kind} disabled={bool(p.disabled) || loading} onPress={() => void fire(p.onPress)} />
    </Box>
  );
}

export function DividerNode({ node }: NodeProps) {
  const gap = spaceOf(node.props.spacing) ?? "s";
  const label = str(node.props.label);
  if (!label) return <View style={{ paddingVertical: space[gap] }}><Divider /></View>;
  return (
    <Box row gap="m" style={[CENTER_ROW, { paddingVertical: space[gap] }]}>
      <View style={FLEX}><Divider /></View>
      <Text size="caption" tone="textTertiary">{label}</Text>
      <View style={FLEX}><Divider /></View>
    </Box>
  );
}

export function EmptyStateNode({ node }: NodeProps) {
  const { render } = useSurface();
  const p = node.props;
  return (
    <Box gap="m" pad="l" center>
      <EmptyState symbol={str(p.icon) ?? "archivebox"} title={str(p.title) ?? ""} subtitle={str(p.description)} />
      {isNode(p.actions) ? render(p.actions, 0) : null}
    </Box>
  );
}

export function ProgressNode({ node }: NodeProps) {
  const p = node.props;
  const total = num(p.total) ?? 1;
  const value = num(p.value) ?? 0;
  const label = str(p.label);
  const role = fillToneOf(p.tone) ?? "accent";
  return (
    <Box gap="xs">
      {label ? (
        <Box row style={BETWEEN}>
          <Text size="small" tone="textSecondary">{label}</Text>
          <Text size="small" tone="textTertiary">{`${Math.round((total > 0 ? value / total : 0) * 100)}%`}</Text>
        </Box>
      ) : null}
      <ProgressTrack value={total > 0 ? value / total : 0} tone={role} />
    </Box>
  );
}

export function PopoverNode({ node }: NodeProps) {
  const title = str(node.props.title);
  const height = num(node.props.height);
  return (
    <Box gap="s" pad="m" style={height ? { maxHeight: height } : undefined}>
      {title ? <Text weight="semibold">{title}</Text> : null}
      <Children node={node} />
    </Box>
  );
}

export function WebViewNode({ node }: NodeProps) {
  const { plugin, fire } = useSurface();
  const url = pluginFileUrl(plugin, str(node.props.src));
  const onMessage = node.props.onMessage;
  const height = num(node.props.height) ?? SURFACE.listMaxHeight;
  if (!url) return <Text size="small" tone="textTertiary">This view points at a file the plugin doesn't have.</Text>;
  return (
    <View style={{ height, overflow: "hidden" }}>
      <PluginFileView plugin={plugin} url={url} themed={node.props.themed !== false} onMessage={isHandlerRef(onMessage) ? (message) => fire(onMessage, [message], { gesture: false }) : undefined} />
    </View>
  );
}

export function ActionPanelNode({ node }: NodeProps) {
  return <ActionButtons panel={node} />;
}

export function ActionNode({ node }: NodeProps) {
  const run = useRunAction();
  const p = node.props;
  const actions = useMemo(() => [node], [node]);
  useShortcutRegistration(actions);
  return (
    <WithShortcutHint hint={shortcutHint(panelShortcuts(actions).get(node))}>
      <Button title={str(p.title) ?? "Action"} icon={str(p.icon)} kind={bool(p.destructive) ? "destructive" : "default"} onPress={() => void run(node)} />
    </WithShortcutHint>
  );
}

export function SurfaceIcon({ name, tone, size = SURFACE.icon }: { name: string | undefined; tone?: unknown; size?: number }) {
  const theme = useTheme();
  if (!name) return null;
  return <Symbol name={name} size={size} color={theme[toneOf(tone, "icon")]} style={ICON} />;
}

export function SurfaceScroll({ children }: { children: ReactNode }) {
  return (
    <ScrollView style={FIT_SCROLL}>
      {children}
    </ScrollView>
  );
}

const FLEX = { flex: 1 } as const;
const FIT_SCROLL = { flexGrow: 0, flexShrink: 1 } as const;
const CENTER_ROW = { alignItems: "center" } as const;
const BETWEEN = { justifyContent: "space-between" } as const;
const SPINNER = { width: SURFACE.spinner, height: SURFACE.spinner } as const;
const ICON = { width: SURFACE.iconBox, height: SURFACE.iconBox } as const;
