import { confirm } from "../../platform/dialogs";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { consentToken } from "../telemetry/choice";
import { notePlugin } from "../telemetry/pluginCounts";
import { removalIdentity, removePlugin } from "./lifecycle";

export async function removePluginAfterConfirm(name: string, title: string, windowId: string): Promise<boolean> {
  const consent = consentToken();
  const identity = removalIdentity(name);
  const { confirmed } = await confirm({
    title: `Remove ${title}?`,
    message:
      identity.source === "store"
        ? "Its download, its commands on your PATH, its data and its panel's website data are removed."
        : identity.source === "dev"
          ? "Its dev link is removed, along with its data and its panel's website data. Your project's folder stays."
          : `Its folder moves to the ${PLATFORM_TERMS.trash}, and its data and its panel's website data are deleted.`,
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
