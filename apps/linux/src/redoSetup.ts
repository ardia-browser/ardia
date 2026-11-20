import { routeUtilityCommand } from "./appServices";
import { BROWSER_COMMAND_CHANNEL } from "./browserCommandRoute";
import { reportHostError } from "./host";

export async function redoSetupFromSettings() {
  const channel = new BroadcastChannel(BROWSER_COMMAND_CHANNEL);
  try {
    await routeUtilityCommand("settings", "redoSetup", channel);
  } catch (error) {
    reportHostError(error);
  } finally {
    channel.close();
  }
}
