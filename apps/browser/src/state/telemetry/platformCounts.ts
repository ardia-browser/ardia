import { launchLinks } from "../../platform/launchLinks";
import { takeAnimationBursts, watchAnimationBursts } from "./animationBursts";
import { checkDefaultBrowserAtLaunch, takeDefaultBrowserCounts } from "./defaultBrowserCounts";
import { takeIntroCounts } from "./introCounts";
import { takeUpdateCounts } from "./updateCounts";

export function watchPlatformCounts() {
  watchAnimationBursts();
  checkDefaultBrowserAtLaunch();
}

export const takePlatformCounts = () => ({ ...takeAnimationBursts(), ...takeDefaultBrowserCounts(), ...takeIntroCounts(), ...takeUpdateCounts(), launch_command_line_links: launchLinks.takeOpenedAtLaunch() });
