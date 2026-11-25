import { ENGINE_NAMES, type EngineMode, type PageEngine } from "./engines";

type ModeFacts = { mode: EngineMode; switching: boolean; defaultEngine: PageEngine; streamingInWebKit: boolean };

export function engineModeFooter({ mode, switching, defaultEngine, streamingInWebKit }: ModeFacts): string {
  if (switching) return "Switching…";
  if (mode === "chromium") return "Opens every page in Chromium (no FairPlay video).";
  if (mode === "webkit") return "Opens pages in WebKit (no extensions).";
  const opens = `Most pages open in ${ENGINE_NAMES[defaultEngine]}.`;
  return streamingInWebKit && defaultEngine === "chromium" ? `${opens} Streaming sites open in WebKit to play protected video.` : opens;
}
