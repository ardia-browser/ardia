import { unavailableError } from "./hostCapabilities.ts";
import { hostSupports } from "./host.ts";

export const CAST_UNAVAILABLE_TITLE = "Casting Isn't Available";
const CAST_UNAVAILABLE_MESSAGE = "Ardia for Linux can't cast tabs yet.";

const UNAVAILABLE: Record<string, string> = {
  startCasting: "Casting",
  stopCasting: "Casting",
  closeCastDialog: "Casting",
  terminateCastRoute: "Casting",
  changeCaptureSource: "Switching the shared tab",
  stopCapture: "Stopping a capture from Ardia",
};

async function noticeCastUnavailable(args: string) {
  let tabId: unknown;
  try { tabId = (JSON.parse(args) as { tabId?: unknown } | null)?.tabId; } catch { tabId = null; }
  const [{ useBrowser }, { showToast }] = await Promise.all([
    import("../../browser/src/state/browser/store"),
    import("../../browser/src/state/app/toasts"),
  ]);
  const s = useBrowser.getState();
  const tab = typeof tabId === "string" ? s.tabs[tabId] : undefined;
  const windowId = tab?.windowId ?? s.ui.focusOrder[0] ?? null;
  if (windowId) showToast(windowId, CAST_UNAVAILABLE_TITLE, CAST_UNAVAILABLE_MESSAGE, { icon: "tv.and.mediabox" });
}

const HOST_CAPTURE_VERBS = new Set(["changeCaptureSource", "stopCapture"]);
const CAST_VERBS = ["showCastDialog", "startCasting", "stopCasting", "closeCastDialog", "watchCastRoutes", "terminateCastRoute"];

const castsTabs = (supports: (method: string) => boolean) => CAST_VERBS.every((verb) => supports(`media.${verb}`));

export function linuxMediaCall(verb: string, args: string, supports: (method: string) => boolean = (method) => hostSupports(method)): Promise<string> | undefined {
  if (CAST_VERBS.includes(verb) && castsTabs(supports)) return undefined;
  if (verb === "showCastDialog") return noticeCastUnavailable(args).then(() => "false", () => "false");
  if (verb === "watchCastRoutes") return Promise.resolve("null");
  if (HOST_CAPTURE_VERBS.has(verb) && supports(`media.${verb}`)) return undefined;
  const feature = UNAVAILABLE[verb];
  return feature ? Promise.reject(unavailableError(feature)) : undefined;
}
