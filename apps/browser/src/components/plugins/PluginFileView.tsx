import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { PluginPageView } from "../ui";
import { usePluginApproval, usePluginFolderId, usePluginNetwork, usePluginPageRun } from "../../state/plugins/hooks";
import { usePluginThemeCss } from "./pluginThemeCss";

type PluginFileViewProps = {
  plugin: string;
  url: string;
  context?: string;
  themed?: boolean;
  style?: StyleProp<ViewStyle>;
  onMessage?: (message: unknown) => void;
};

const parsedMessage = (body: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false };
  }
};

export function PluginFileView({ plugin, url, context = "", themed = true, style, onMessage }: PluginFileViewProps) {
  const network = usePluginNetwork(plugin);
  const folderId = usePluginFolderId(plugin);
  const run = usePluginPageRun(plugin);
  const approved = usePluginApproval(plugin);
  const themeCss = usePluginThemeCss();
  return (
    <PluginPageView
      style={style ?? StyleSheet.absoluteFill}
      plugin={plugin}
      url={url}
      network={network}
      folderId={folderId}
      approved={approved}
      run={run}
      context={context}
      themeCss={themed ? themeCss : undefined}
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
