import { useEffect, useRef } from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { updateLive, updateTab } from "../../state/tabs/actions";
import { registerPageNavigator } from "../../state/tabs/navigation";
import { routePluginPage } from "../../state/plugins/actions";
import { PluginPageView } from "../ui";
import { usePluginApproval, usePluginFolderId, usePluginNetwork, usePluginPageRun, usePluginStoreKey } from "../../state/plugins/hooks";
import { useWindowId } from "../../state/browser/hooks";
import { usePluginThemeCss } from "./pluginThemeCss";

type PluginFileViewProps = {
  plugin: string;
  url: string;
  context?: string;
  themed?: boolean;
  style?: StyleProp<ViewStyle>;
  onMessage?: (message: unknown) => void;
  tabId?: string;
  load?: number;
};

type NavigableView = { goBack(): Promise<void>; goForward(): Promise<void> };

const parsedMessage = (body: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false };
  }
};

export function PluginFileView({ plugin, url, context = "", themed = true, style, onMessage, tabId, load = 0 }: PluginFileViewProps) {
  const view = useRef<NavigableView | null>(null);
  useEffect(() => {
    if (!tabId) return;
    return registerPageNavigator(tabId, { goBack: () => view.current?.goBack(), goForward: () => view.current?.goForward() });
  }, [tabId]);
  const network = usePluginNetwork(plugin);
  const folderId = usePluginFolderId(plugin);
  const run = usePluginPageRun(plugin);
  const approved = usePluginApproval(plugin);
  const themeCss = usePluginThemeCss();
  const storeKey = usePluginStoreKey(plugin, tabId ?? null, useWindowId());
  return (
    <PluginPageView
      // @ts-expect-error expo view managers accept a ref to their AsyncFunctions
      ref={view}
      style={style ?? StyleSheet.absoluteFill}
      plugin={plugin}
      url={url}
      network={network}
      folderId={folderId}
      storeKey={storeKey}
      approved={approved}
      run={run}
      context={context}
      themeCss={themed ? themeCss : undefined}
      onTitleChange={tabId ? (e) => e.nativeEvent.title && updateTab(tabId, { title: e.nativeEvent.title.slice(0, 300) }) : undefined}
      onNavigationChange={
        tabId
          ? (e) => {
              updateLive(tabId, { canGoBack: e.nativeEvent.canGoBack, canGoForward: e.nativeEvent.canGoForward });
              routePluginPage(tabId, plugin, e.nativeEvent.url, load);
            }
          : undefined
      }
      onMessage={
        onMessage
          ? (e) => {
              const parsed = parsedMessage(e.nativeEvent.body);
              if (parsed.ok) onMessage(parsed.value);
            }
          : undefined
      }
    />
  );
}
