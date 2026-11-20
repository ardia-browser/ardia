import { ENGINE_NAMES, type EngineMode, type PageEngine } from "./engines";

type ModeFacts = { mode: EngineMode; switching: boolean; defaultEngine: PageEngine; streamingInWebKit: boolean; webKitExtensions: boolean };

export function engineModeFooter({ mode, switching, defaultEngine, streamingInWebKit, webKitExtensions }: ModeFacts): string {
  if (switching) return "Switching…";
  if (mode === "chromium") return "Every page opens in Chromium. Netflix and other sites with protected video won't play.";
  if (mode === "webkit") {
    const kept = "Extension pages and the Chrome Web Store still open in Chromium.";
    return webKitExtensions ? `Pages open in WebKit. ${kept}` : `Pages open in WebKit, without extensions on this version of macOS. ${kept}`;
  }
  const opens = `Most pages open in ${ENGINE_NAMES[defaultEngine]}.`;
  return streamingInWebKit && defaultEngine === "chromium" ? `${opens} Streaming sites open in WebKit to play protected video.` : opens;
}
