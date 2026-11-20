import { confirm } from "../../platform/dialogs";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { consentToken } from "../telemetry/choice";
import { notePlugin } from "../telemetry/pluginCounts";
import { removePlugin } from "./lifecycle";

export async function removePluginAfterConfirm(name: string, title: string, windowId: string): Promise<boolean> {
  const consent = consentToken();
  const { confirmed } = await confirm({
    title: `Remove ${title}?`,
    message: `Its folder moves to the ${PLATFORM_TERMS.trash}, and its data and its panel's website data are deleted.`,
    confirmTitle: "Remove",
    destructive: true,
    windowId,
  });
  if (!confirmed) {
    notePlugin("plugin_removals_cancelled", consent);
    return false;
  }
  const removed = await removePlugin(name);
  if (removed.ok || removed.removed) notePlugin("plugin_removals", consent);
  return removed.ok || removed.removed === true;
}
