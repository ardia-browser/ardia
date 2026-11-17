import { NO_LAUNCH_ARGUMENTS, parseLaunchArguments, type LaunchArguments } from "../../lib/launchArguments";
import { launchedForSyncDemo, launchValues } from "../../platform/launch";

let launch: LaunchArguments = NO_LAUNCH_ARGUMENTS;
let read = false;
let demoSession: boolean | null = null;

export function launchArguments(): LaunchArguments {
  if (!read) {
    read = true;
    launch = parseLaunchArguments(launchValues());
  }
  return launch;
}

export const isDemoSession = (): boolean => (demoSession ??= launchArguments().isDemo || launchedForSyncDemo());
