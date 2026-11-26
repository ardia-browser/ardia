import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import type { PanelSpec } from "../../lib/pluginManifest";
import { Box, Button, Text } from "../ui";
import { useTab, useWindowId } from "../../state/browser/hooks";
import { usePluginActive, usePluginManifest, usePluginPageContext, usePluginPageSpec, usePluginPageUrl, usePluginProcess, usePluginWindowEligible } from "../../state/plugins/hooks";
import { pluginPagePath } from "../../state/plugins/actions";
import { panelOfPath, wakeForFilePage } from "../../state/plugins/pages";
import { openSettings } from "../../state/settings/settingsWindows";
import { PluginFileView } from "./PluginFileView";
import { PluginSurface } from "./PluginSurface";

function Notice({ title, detail, name }: { title: string; detail: string; name: string }) {
  return (
    <Box pad="xl" gap="m" style={CENTER}>
      <Text size="title" weight="semibold">
        {title}
      </Text>
      <Text tone="textSecondary">{detail}</Text>
      <Button title="Open Plugin Settings" onPress={() => openSettings("plugins", null, name)} />
    </Box>
  );
}

const isPagePanel = (p: PanelSpec) => p.mode === "tab" || p.mode === "split";

function viewPanelOf(panels: readonly PanelSpec[], path: string): PanelSpec | null {
  const panelId = panelOfPath(path);
  if (panelId) return panels.find((p) => p.id === panelId && isPagePanel(p) && !!p.view && !p.file) ?? null;
  if (panels.some((p) => isPagePanel(p) && p.file)) return null;
  return panels.find((p) => isPagePanel(p) && !!p.view) ?? null;
}

export function PluginPage({ tabId, name }: { tabId: string; name: string }) {
  const windowId = useWindowId();
  const eligible = usePluginWindowEligible(windowId);
  const path = useTab(tabId, (t) => pluginPagePath(t?.url ?? ""));
  const spec = usePluginPageSpec(name);
  const manifest = usePluginManifest(name);
  const active = usePluginActive(name);
  const context = usePluginPageContext(tabId, name);
  const url = usePluginPageUrl(name, path);
  const process = usePluginProcess(name);
  const viewPanel = manifest ? viewPanelOf(manifest.contributes.panels, path) : null;
  const title = spec?.title ?? viewPanel?.title ?? manifest?.title ?? name;
  useEffect(() => {
    if (eligible && active && url) wakeForFilePage(name, path);
  }, [eligible, active, url, name, path]);
  if (!eligible) return <Notice name={name} title="Plugins aren't available in private windows" detail="Open this plugin in a regular window." />;
  if (!active || (!spec && !viewPanel)) return <Notice name={name} title={`${title} is off`} detail="Turn the plugin on in Settings › Plugins to use its page." />;
  if (viewPanel?.view && !url) {
    return (
      <View style={StyleSheet.absoluteFill}>
        <Box pad="m" style={FILL}>
          <PluginSurface plugin={name} surfaceId={`${viewPanel.view}@${tabId}`} viewId={viewPanel.view} kind="panel" windowId={windowId} context={{ tabId, panelId: viewPanel.id }} />
        </Box>
      </View>
    );
  }
  if (!url) {
    const failed = process?.state === "crashed" || process?.state === "failed";
    return <Notice name={name} title={failed ? `${title} stopped` : `${title} is starting…`} detail={failed ? "Its program isn't running. Restart it from Settings › Plugins." : "Its program is getting the page ready."} />;
  }
  return (
    <View style={StyleSheet.absoluteFill}>
      <PluginFileView plugin={name} url={url} context={context} />
    </View>
  );
}

const CENTER = { flex: 1, alignItems: "center", justifyContent: "center" } as const;
const FILL = { flex: 1 } as const;
