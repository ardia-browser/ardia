import { launchLinks } from "../../platform/launchLinks";
import { takeAnimationBursts, watchAnimationBursts } from "./animationBursts";
import { checkDefaultBrowserAtLaunch, takeDefaultBrowserCounts } from "./defaultBrowserCounts";
import { takeIntroCounts } from "./introCounts";
import { takeKeyringCounts } from "./keyringCounts";
import { takeUpdateCounts } from "./updateCounts";
import { takeWindowRootCounts } from "./windowRootCounts";

export function watchPlatformCounts() {
  watchAnimationBursts();
  checkDefaultBrowserAtLaunch();
}

export const takePlatformCounts = () => ({ ...takeAnimationBursts(), ...takeDefaultBrowserCounts(), ...takeIntroCounts(), ...takeUpdateCounts(), ...takeKeyringCounts(), ...takeWindowRootCounts(), launch_command_line_links: launchLinks.takeOpenedAtLaunch() });
