import { setAppearance, setThinScrollBars } from "../../platform/app";
import { setAutoPictureInPicture, setVideoUpscaling } from "../../platform/media";
import { setCommandScrollZoom } from "../../platform/siteSettings";
import { setPopupsOpenAsTabs } from "../../platform/pageOptions";
import { setBlockAutoplayEverywhere, setFairPlayInChromium } from "../../platform/pageOptions";
import { useBrowser } from "../browser/store";
import type { Settings } from "./settings";
import { startInterfaceScale } from "./interfaceScaleSync";

type Mirror = { key: keyof Settings; send: (settings: Settings) => unknown };

const mirror = <K extends keyof Settings>(key: K, send: (value: Settings[K]) => unknown): Mirror => ({ key, send: (settings) => send(settings[key]) });

const NATIVE_SETTINGS: Mirror[] = [
  mirror("appearance", setAppearance),
  mirror("autoPictureInPicture", setAutoPictureInPicture),
  mirror("videoUpscaling", setVideoUpscaling),
  mirror("popupsOpenAsTabs", setPopupsOpenAsTabs),
  mirror("blockAutoplayEverywhere", setBlockAutoplayEverywhere),
  mirror("fairPlayInChromium", setFairPlayInChromium),
];

export function startNativeSettings() {
  startInterfaceScale();
  void setThinScrollBars(false);
  void setCommandScrollZoom(true);
  const sent = new Map<keyof Settings, unknown>();
  const sync = (settings: Settings) => {
    for (const { key, send } of NATIVE_SETTINGS) {
      if (sent.has(key) && sent.get(key) === settings[key]) continue;
      sent.set(key, settings[key]);
      void send(settings);
    }
  };
  sync(useBrowser.getState().settings);
  return useBrowser.subscribe((s, prev) => s.settings !== prev.settings && sync(s.settings));
}
