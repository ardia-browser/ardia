import { pages, system } from "@ardia/phone-native";
import type { LaunchValue } from "../lib/launchArguments";

export function launchValues(): Record<string, LaunchValue> {
  try {
    const options = pages.launchOptions();
    return options?.arguments ?? {};
  } catch {
    return {};
  }
}

export function launchedForSyncDemo(): boolean {
  try {
    return pages.launchOptions()?.syncDemo === true;
  } catch {
    return false;
  }
}

export function markInterfaceDrawn() {
  try {
    system.launchInterfaceDrawn();
  } catch {
    return;
  }
}
