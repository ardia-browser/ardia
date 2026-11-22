import { ENGINE_NAMES, type EngineMode, type PageEngine } from "./engines";
import { t } from "../../lib/uiLanguage";


type ModeFacts = { mode: EngineMode; switching: boolean; defaultEngine: PageEngine; streamingInWebKit: boolean };

export function engineModeFooter({ mode, switching, defaultEngine, streamingInWebKit }: ModeFacts): string {
  if (switching) return t(`Switching…`);
  if (mode === "chromium") return t(`Every page opens in Chromium. Netflix and other sites with protected video won't play.`);
  if (mode === "webkit") return t(`Pages open in WebKit, without extensions. Extension pages and the Chrome Web Store still open in Chromium.`);
  const opens = `Most pages open in ${ENGINE_NAMES[defaultEngine]}.`;
  return streamingInWebKit && defaultEngine === "chromium" ? `${opens} Streaming sites open in WebKit to play protected video.` : opens;
}
