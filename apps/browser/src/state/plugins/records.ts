import { loadPluginsExtras, readPluginRecords } from "./savedState";
import { usePlugins } from "./store";

export function loadPluginRecords() {
  if (usePlugins.getState().loaded) return;
  loadPluginsExtras();
  usePlugins.setState({ loaded: true, records: readPluginRecords() });
}
