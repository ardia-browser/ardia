import type { HoverLostEpisode } from "../../platform/performance";

const MAX_HOVER_LOST_SECONDS = 24 * 60 * 60;
const MAX_OTHER_WINDOW_CLICKS = 1000;

const HOVER_REASONS = new Set(["halfActive", "staleMenu", "notKeyOrMain", "coveredByView", "responderLost", "coveredByWindow"]);
const HOVER_RESPONDERS = new Set(["none", "window", "otherWindow", "page", "control"]);
const HOVER_WINDOW_KINDS = new Set(["none", "hidden", "blockerPage", "internal", "ardiaPanel", "popup", "browser", "other"]);
const HOVER_COVERS = new Set(["none", "reactNative", "chromium", "other"]);
const HOVER_ENDINGS = new Set(["hover", "heal", "appInactive", "windowClosed"]);
const HEAL_REFUSALS = new Set([
  "none",
  "notVisible",
  "notOnActiveSpace",
  "notInFront",
  "modalWindow",
  "attachedSheet",
  "savePanel",
  "menuActive",
  "menuShown",
  "fullScreenMoving",
  "notClick",
  "keyPopup",
  "notEligible",
]);
const REFUSED_WINDOW_KINDS = new Set(["window", "panel", "menu", "sharing", "tooltip", "popover", "fullScreen", "ardia", "other"]);
const REFUSED_WINDOW_LEVELS = new Set(["normal", "floating", "raised", "popUp"]);
const REFUSED_WINDOW_PARENTS = new Set(["none", "browser", "other"]);

export const oneOf = (allowed: Set<string>, value: unknown) => (typeof value === "string" && allowed.has(value) ? value : "unknown");

function refusedWindow(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  if (value === "none") return "none";
  const [kind = "", level = "", parent = "", ...rest] = value.split(":");
  return rest.length === 0 && REFUSED_WINDOW_KINDS.has(kind) && REFUSED_WINDOW_LEVELS.has(level) && REFUSED_WINDOW_PARENTS.has(parent) ? value : "unknown";
}

const clickCount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(0, Math.round(value)), MAX_OTHER_WINDOW_CLICKS) : null;

export function hoverLostProperties(e: HoverLostEpisode, sessionMin: number) {
  return {
    reason: oneOf(HOVER_REASONS, e.reason),
    trigger: e.trigger === "click" ? "click" : "move",
    key_window: oneOf(HOVER_WINDOW_KINDS, e.keyWindow),
    main_window: oneOf(HOVER_WINDOW_KINDS, e.mainWindow),
    prevent_key: e.preventKey === true,
    can_key: e.canKey === true,
    window_main: e.windowMain === true,
    half_active: e.halfActive === true,
    app_active: e.appActive === true,
    running_active: e.runningActive === true,
    frontmost: e.frontmost === true,
    menu_active: e.menuActive === true,
    over_page: e.overPage === true,
    cover: oneOf(HOVER_COVERS, e.cover),
    cover_clear: e.coverClear === true,
    responder: oneOf(HOVER_RESPONDERS, e.responder),
    cover_window: oneOf(HOVER_WINDOW_KINDS, e.coverWindow ?? "none"),
    healed: e.healed === true,
    heal_worked: typeof e.healWorked === "boolean" ? e.healWorked : null,
    heal_refused: oneOf(HEAL_REFUSALS, e.healRefused),
    heal_refused_last: oneOf(HEAL_REFUSALS, e.healRefusedLast),
    heal_refused_window: refusedWindow(e.healRefusedWindow),
    other_window_clicks: clickCount(e.otherWindowClicks),
    ended_by: oneOf(HOVER_ENDINGS, e.endedBy),
    lost_seconds: Number.isFinite(e.seconds) ? Math.min(Math.max(0, Math.round(e.seconds)), MAX_HOVER_LOST_SECONDS) : null,
    session_min: sessionMin,
  };
}
