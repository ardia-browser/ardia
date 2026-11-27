import { settingsSyncWaitsAtLaunch } from "../../browser/src/state/sync/settingsSyncAtLaunch";

export async function settingsSyncWaitsAtDesktopLaunch(refresh: (name: string) => Promise<boolean>, waits: () => boolean = settingsSyncWaitsAtLaunch): Promise<boolean> {
  await refresh("sync.json").catch(() => false);
  return waits();
}
