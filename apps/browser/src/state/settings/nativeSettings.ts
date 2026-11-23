import { setAppearance, setThinScrollBars } from "../../platform/app";
import { setAutoPictureInPicture, setVideoUpscaling } from "../../platform/media";
import { setCommandScrollZoom } from "../../platform/siteSettings";
import { setWebKitFraudWarnings } from "../../platform/webkit";
import { setPopupsOpenAsTabs, setBlockAutoplayEverywhere } from "../../platform/pageOptions";
import { setGeneratedRetention, setVaultOptions } from "../../platform/vaults";
import { useBrowser } from "../browser/store";
import type { Settings } from "./settings";
import { startInterfaceScale } from "./interfaceScaleSync";
import { setPressMotion } from "../../lib/pressMotion";
import { vaultsSupported } from "../vaults/enabled";

type Mirror = { key: string; value: (settings: Settings) => unknown; send: (settings: Settings) => unknown };

const mirror = <K extends keyof Settings>(key: K, send: (value: Settings[K]) => unknown): Mirror => ({ key, value: (settings) => settings[key], send: (settings) => send(settings[key]) });

const vaultOptionsOf = (s: Settings) => ({
  idleLockMinutes: s.vaultIdleLockMinutes,
  touchID: s.vaultTouchID,
  askBeforeFilling: s.vaultAskBeforeFilling,
  iCloudSync: s.vaultICloudSync,
  lockOnQuit: s.vaultLockOnQuit,
  lockOnScreenLock: s.vaultLockOnScreenLock,
});

const VAULT_SETTINGS: Mirror[] = [
  mirror("vaultKeepGenerated", setGeneratedRetention),
  { key: "vaultOptions", value: (s) => JSON.stringify(vaultOptionsOf(s)), send: (s) => setVaultOptions(vaultOptionsOf(s)) },
];

const NATIVE_SETTINGS: Mirror[] = [
  mirror("appearance", setAppearance),
  mirror("autoPictureInPicture", setAutoPictureInPicture),
  mirror("videoUpscaling", setVideoUpscaling),
  mirror("webKitFraudWarnings", setWebKitFraudWarnings),
  mirror("popupsOpenAsTabs", setPopupsOpenAsTabs),
  mirror("blockAutoplayEverywhere", setBlockAutoplayEverywhere),
  mirror("pressMotion", setPressMotion),
  mirror("commandScrollZoom", setCommandScrollZoom),
  ...(vaultsSupported ? VAULT_SETTINGS : []),
];

export function startNativeSettings() {
  startInterfaceScale();
  void setThinScrollBars(false);
  const sent = new Map<string, unknown>();
  const sync = (settings: Settings) => {
    for (const { key, value, send } of NATIVE_SETTINGS) {
      const now = value(settings);
      if (sent.has(key) && sent.get(key) === now) continue;
      sent.set(key, now);
      void Promise.resolve(send(settings)).catch(() => {
        if (sent.get(key) === now) sent.delete(key);
      });
    }
  };
  sync(useBrowser.getState().settings);
  return useBrowser.subscribeTo(["settings"], (s, prev) => s.settings !== prev.settings && sync(s.settings));
}
