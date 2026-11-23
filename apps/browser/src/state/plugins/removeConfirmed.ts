import { confirm } from "../../platform/dialogs";
import { consentToken } from "../telemetry/choice";
import { notePlugin } from "../telemetry/pluginCounts";
import { removalIdentity, removePlugin } from "./lifecycle";
import { removeWords } from "./removeWords";
import { currentPlugins } from "./store";

export async function removePluginAfterConfirm(name: string, title: string, windowId: string): Promise<boolean> {
  const consent = consentToken();
  const identity = removalIdentity(name);
  const official = identity.official;
  const { confirmed } = await confirm({
    title: `Remove ${title}?`,
    message: removeWords(Object.hasOwn(currentPlugins().listings, name) ? currentPlugins().listings[name]!.manifest : null, official).alert,
    confirmTitle: "Remove",
    destructive: true,
    windowId,
  });
  if (!confirmed) {
    notePlugin("plugin_removals_cancelled", consent);
    return false;
  }
  const removed = await removePlugin(name, undefined, identity);
  if (removed.ok || removed.removed) notePlugin("plugin_removals", consent);
  return removed.ok || removed.removed === true;
}
