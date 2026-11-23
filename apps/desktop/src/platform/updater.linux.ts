import type { ArdiaHost } from "../host";
import type { UPDATE_METHODS } from "./linux/hostUpdates.ts";
import { linuxUpdaterFor } from "./linux/linuxUpdates.ts";

export { startLinuxUpdates as startUpdates, updateMenuItem } from "./linux/linuxUpdates.ts";

export const updaterMethod = (host: ArdiaHost, method: string) =>
  linuxUpdaterFor(host).methods[method as (typeof UPDATE_METHODS)[number]] as (...args: unknown[]) => Promise<unknown>;

export function runMenuUpdate(host: ArdiaHost, restart: boolean): Promise<unknown> | null {
  const updater = linuxUpdaterFor(host);
  return restart ? updater.restartWhenReady() : updater.check(true);
}
