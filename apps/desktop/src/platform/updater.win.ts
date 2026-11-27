import type { ArdiaHost } from "../host";
import type { UPDATE_METHODS } from "./win/hostUpdates.ts";
import { windowsUpdaterFor } from "./win/windowsUpdates.ts";

export { startWindowsUpdates as startUpdates, updateMenuItem } from "./win/windowsUpdates.ts";

export const updaterMethod = (host: ArdiaHost, method: string) =>
  windowsUpdaterFor(host).methods[method as (typeof UPDATE_METHODS)[number]] as ((...args: unknown[]) => Promise<unknown>) | undefined;

export function runMenuUpdate(host: ArdiaHost, restart: boolean): Promise<unknown> | null {
  const updater = windowsUpdaterFor(host);
  return restart ? updater.restartWhenReady() : updater.check(true);
}
