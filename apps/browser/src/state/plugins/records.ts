import { readPluginRecords } from "./savedState";
import { usePlugins } from "./store";

export function loadPluginRecords() {
  if (usePlugins.getState().loaded) return;
  usePlugins.setState({ loaded: true, records: readPluginRecords() });
}
