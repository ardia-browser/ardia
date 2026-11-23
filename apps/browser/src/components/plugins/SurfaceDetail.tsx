import { Pressable } from "react-native";
import type { PluginNode } from "../../lib/pluginProtocol";
import { newTab } from "../../state/tabs/actions";
import { ActivitySpinner, Box, Divider, Text, useClosing, useLiveAction } from "../ui";
import { ActionButtons } from "./SurfaceActions";
import { Children, SurfaceIcon, SurfaceScroll } from "./SurfaceBasics";
import { SurfaceMarkdown } from "./SurfaceMarkdown";
import { SURFACE } from "./tokens";
import { bool, isWebUrl, records, str, toneOf, useSurface } from "./surfaceNodes";
import { ShortcutScopeContext, useDeeperShortcutScope } from "./surfaceShortcuts";

export function DetailNode({ node }: { node: PluginNode }) {
  const p = node.props;
  const markdown = str(p.markdown);
  const metadata = records(p.metadata);
  const deeper = useDeeperShortcutScope();
  return (
    <SurfaceScroll>
      <Box gap="l" pad="m">
        {bool(p.isLoading) ? <ActivitySpinner style={SPINNER} /> : null}
        {markdown ? <SurfaceMarkdown source={markdown} /> : null}
        <ShortcutScopeContext.Provider value={deeper}>
          <Children node={node} />
        </ShortcutScopeContext.Provider>
        {metadata.length ? (
          <Box gap="s">
            <Divider />
            {metadata.map((row, index) => (
              <MetadataRow key={`${index}:${str(row.label) ?? ""}`} row={row} />
            ))}
          </Box>
        ) : null}
        <ActionButtons panel={p.actions} />
      </Box>
    </SurfaceScroll>
  );
}

function MetadataRow({ row }: { row: Record<string, unknown> }) {
  const { windowId } = useSurface();
  const closing = useClosing();
  const live = useLiveAction();
  const url = isWebUrl(row.url) ? row.url : null;
  const value = (
    <Box row gap="xs" style={VALUE}>
      <SurfaceIcon name={str(row.icon)} tone={row.tone} size={SURFACE.smallIcon} />
      <Text size="small" tone={url ? "accent" : toneOf(row.tone)} numberOfLines={2} selectable style={SHRINK}>
        {str(row.text) ?? url ?? ""}
      </Text>
    </Box>
  );
  return (
    <Box row gap="m" style={ROW}>
      <Text size="small" tone="textSecondary" style={LABEL}>
        {str(row.label) ?? ""}
      </Text>
      {url ? <Pressable disabled={closing} onPress={live(() => newTab(windowId, { url }))}>{value}</Pressable> : value}
    </Box>
  );
}

const SHRINK = { flexShrink: 1 } as const;
const ROW = { alignItems: "flex-start" } as const;
const VALUE = { flex: 1, alignItems: "center" } as const;
const LABEL = { width: SURFACE.metaLabel } as const;
const SPINNER = { width: SURFACE.spinner, height: SURFACE.spinner } as const;
