import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { PanelSpec } from "../../lib/pluginManifest";
import { Box, Button, Text } from "../ui";
import { useTab, useWindowId } from "../../state/browser/hooks";
import { usePluginActive, usePluginManifest, usePluginPageContext, usePluginPageSpec, usePluginPageUrl, usePluginProcess, usePluginWindowEligible } from "../../state/plugins/hooks";
import { pluginPagePath } from "../../state/plugins/actions";
import { pageRoutes, panelOfPath, pluginPageUrl, routePluginPage, wakeForFilePage } from "../../state/plugins/pages";
import { usePlugins } from "../../state/plugins/store";
import { currentTab } from "../../state/browser/current";
import { tabDestination } from "../../state/pages/urls";
import { updateTab } from "../../state/tabs/actions";
import { endPluginPageVisit, notePluginPageVisit } from "../../state/plugins/pageVisits";
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

const withoutRoute = (url: string | null) => url?.replace(/[?&]ardiaPath=[^&#]*/, "") ?? null;

function useLoadUrl(url: string | null, routes: boolean): string | null {
  const held = useRef<string | null>(null);
  if (!routes || !url || withoutRoute(held.current) !== withoutRoute(url)) held.current = url;
  return held.current;
}

function usePageTitle(tabId: string, name: string, path: string, fallback: string, documentTitle: string | null) {
  const title = documentTitle?.trim() || fallback;
  useEffect(() => {
    const t = currentTab(tabId);
    if (t && t.title !== title) updateTab(tabId, { title });
  }, [tabId, title, path]);
  useEffect(() => {
    if (documentTitle !== null) notePluginPageVisit(tabId, pluginPageUrl(name, path), documentTitle.trim());
  }, [tabId, name, path, documentTitle]);
  useEffect(() => () => endPluginPageVisit(tabId), [tabId]);
}

export function PluginPage({ tabId, name }: { tabId: string; name: string }) {
  const windowId = useWindowId();
  const eligible = usePluginWindowEligible(windowId);
  const path = useTab(tabId, (t) => pluginPagePath(t ? tabDestination(t) : ""));
  const spec = usePluginPageSpec(name);
  const manifest = usePluginManifest(name);
  const active = usePluginActive(name);
  const context = usePluginPageContext(tabId, name);
  const routes = usePlugins((s) => pageRoutes(s, name, path));
  const url = useLoadUrl(usePluginPageUrl(name, path), routes);
  const [documentTitle, setDocumentTitle] = useState("");
  const process = usePluginProcess(name);
  const viewPanel = manifest ? viewPanelOf(manifest.contributes.panels, path) : null;
  const title = spec?.title ?? viewPanel?.title ?? manifest?.title ?? name;
  usePageTitle(tabId, name, path, title, url && eligible && active ? documentTitle : null);
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
      <PluginFileView
        plugin={name}
        url={url}
        context={context}
        route={{ tabId, routes, path, onNavigate: (body) => void routePluginPage(tabId, name, body), onTitle: setDocumentTitle }}
      />
    </View>
  );
}

const CENTER = { flex: 1, alignItems: "center", justifyContent: "center" } as const;
const FILL = { flex: 1 } as const;
