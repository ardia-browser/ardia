import { launchAddresses, type LaunchArguments } from "../../../../expo-windows/src/launchLinks/addresses";
import { callMainSync, mainModules } from "../../bridge";
import { emitWhenListened } from "../../events";

let read = false;
let openedAtLaunch = 0;

export function openLaunchLinks() {
  if (read || !mainModules().ArdiaLaunchLinks?.sync.includes("launchArguments")) return;
  read = true;
  const urls = launchAddresses(callMainSync<LaunchArguments>("ArdiaLaunchLinks", "launchArguments"));
  if (!urls.length) return;
  openedAtLaunch += urls.length;
  console.info(`[ardia linux] launch links: ${urls.length} held until the app listens`);
  emitWhenListened("ArdiaShell", "onOpenURLs", { urls });
}

export const launchLinksModules: Record<string, Record<string, unknown>> = {
  ArdiaLaunchLinks: {
    takeOpenedAtLaunch() {
      const taken = openedAtLaunch;
      openedAtLaunch = 0;
      return taken;
    },
  },
};
