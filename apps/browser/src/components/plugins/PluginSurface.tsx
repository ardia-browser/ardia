import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import type { PluginNode, SurfaceKind } from "../../lib/pluginProtocol";
import { dispatchPluginSurfaceEvent, mountPluginSurface, nextSurfaceInstanceId, unmountPluginSurface } from "../../state/plugins/actions";
import { usePluginSurfaceTree } from "../../state/plugins/hooks";
import { ActivitySpinner, Box, Text } from "../ui";
import {
  ActionNode,
  ActionPanelNode,
  BadgeNode,
  BoxNode,
  ButtonNode,
  Children,
  DividerNode,
  EmptyStateNode,
  MarkdownNode,
  PopoverNode,
  ProgressNode,
  TextNode,
  WebViewNode,
} from "./SurfaceBasics";
import { DetailNode } from "./SurfaceDetail";
import { FormNode, SelectNode, TextFieldNode, ToggleNode } from "./SurfaceForm";
import { SurfaceShortcutScope } from "./SurfaceActions";
import { ListNode } from "./SurfaceList";
import { SidebarItemNode, SidebarSectionNode, SidebarViewNode } from "./SurfaceSidebar";
import { SURFACE } from "./tokens";
import { isHandlerRef, nodeKey, SurfaceContext, type Child, type SurfaceDispatch, type SurfaceFireOptions } from "./surfaceNodes";
import type { SurfaceKeys } from "./surfaceShortcuts";

const NODES: Record<string, ComponentType<{ node: PluginNode }>> = {
  Fragment: Children,
  Box: BoxNode,
  Text: TextNode,
  Markdown: MarkdownNode,
  Badge: BadgeNode,
  Button: ButtonNode,
  Divider: DividerNode,
  EmptyState: EmptyStateNode,
  Progress: ProgressNode,
  List: ListNode,
  Detail: DetailNode,
  Form: FormNode,
  TextField: TextFieldNode,
  PasswordField: TextFieldNode,
  Toggle: ToggleNode,
  Select: SelectNode,
  SidebarView: SidebarViewNode,
  SidebarSection: SidebarSectionNode,
  SidebarItem: SidebarItemNode,
  Popover: PopoverNode,
  ActionPanel: ActionPanelNode,
  Action: ActionNode,
  WebView: WebViewNode,
};

function renderChild(child: Child, index: number): ReactNode {
  if (typeof child === "string") return child;
  const Node = NODES[child.type] ?? Children;
  return <Node key={nodeKey(child, index)} node={child} />;
}

export function PluginSurface({
  plugin,
  surfaceId,
  viewId,
  kind,
  windowId,
  context,
  onKeys,
}: {
  plugin: string;
  surfaceId: string;
  viewId?: string;
  kind: SurfaceKind;
  windowId: string;
  context?: Record<string, unknown>;
  onKeys?: (keys: SurfaceKeys | null) => void;
}) {
  const wireViewId = viewId ?? surfaceId;
  const [instanceId] = useState(() => nextSurfaceInstanceId(wireViewId));
  const tree = usePluginSurfaceTree(plugin, instanceId);
  const contextKey = context ? JSON.stringify(context) : "";
  useEffect(() => {
    void mountPluginSurface(plugin, instanceId, kind, windowId, context ?? {}, wireViewId);
    return () => unmountPluginSurface(plugin, instanceId, windowId);
  }, [plugin, instanceId, wireViewId, kind, windowId, contextKey]);
  const fire = useCallback(
    (ref: unknown, args: unknown[] = [], options: SurfaceFireOptions = {}) =>
      isHandlerRef(ref) ? dispatchPluginSurfaceEvent(plugin, instanceId, windowId, ref.__handler, args, options) : false,
    [plugin, instanceId, windowId],
  );
  const dispatch = useMemo<SurfaceDispatch>(() => ({ plugin, surfaceId: instanceId, windowId, kind, fire, render: renderChild }), [plugin, instanceId, windowId, kind, fire]);
  return (
    <SurfaceContext.Provider value={dispatch}>
      <SurfaceShortcutScope onKeys={onKeys}>{tree ? renderChild(tree, 0) : <SurfaceLoading />}</SurfaceShortcutScope>
    </SurfaceContext.Provider>
  );
}

function SurfaceLoading() {
  return (
    <Box row gap="s" pad="m" center>
      <ActivitySpinner style={SPINNER} />
      <Text size="small" tone="textTertiary">
        Loading…
      </Text>
    </Box>
  );
}

const SPINNER = { width: SURFACE.spinner, height: SURFACE.spinner } as const;
