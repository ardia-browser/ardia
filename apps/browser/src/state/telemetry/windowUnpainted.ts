import type { WindowUnpaintedRecord } from "../../platform/performance";
import { oneOf } from "./hoverLost";

const MAX_WINDOW_VIEWS = 1_000;
const MAX_HOLD_MS = 600_000;
const UNPAINTED_REASON_BITS = (1 << 9) - 1;

const UNPAINTED_WINDOWS = new Set(["regular", "private"]);
const UNPAINTED_TRIGGERS = new Set(["seen", "key", "profileSwitch"]);
const UNPAINTED_OCCLUSIONS = new Set(["visible", "occluded"]);

const cappedCount = (value: unknown) => (Number.isFinite(value) ? Math.min(Math.max(0, Math.round(value as number)), MAX_WINDOW_VIEWS) : null);
const hasBit = (bits: unknown, bit: number) => typeof bits === "number" && Number.isSafeInteger(bits) && (bits & (1 << bit)) !== 0;
const reasonBits = (bits: unknown) => (typeof bits === "number" && Number.isSafeInteger(bits) && bits >= 0 ? bits & UNPAINTED_REASON_BITS : null);
const holdMilliseconds = (value: unknown) => (Number.isFinite(value) ? Math.min(Math.max(0, Math.round(value as number)), MAX_HOLD_MS) : null);
const flag = (value: unknown) => (typeof value === "boolean" ? value : null);

export function windowUnpaintedProperties(r: WindowUnpaintedRecord, shareTabs: boolean, sessionMin: number) {
  return {
    window: oneOf(UNPAINTED_WINDOWS, r.window),
    trigger: oneOf(UNPAINTED_TRIGGERS, r.trigger),
    seen: r.seen === true,
    occlusion: oneOf(UNPAINTED_OCCLUSIONS, r.occlusion),
    overruled: r.overruled === true,
    app_active: r.appActive === true,
    windows: cappedCount(r.windows),
    share_tabs: shareTabs,
    views: cappedCount(r.views),
    unpainted: cappedCount(r.unpainted),
    alpha_zero: hasBit(r.reasons, 0),
    view_hidden: hasBit(r.reasons, 1),
    page_hidden: hasBit(r.reasons, 2),
    page_detached: hasBit(r.reasons, 3),
    frame_hold_awaiting: hasBit(r.reasons, 4),
    stand_in_lent: hasBit(r.reasons, 5),
    stand_in_leaving: hasBit(r.reasons, 6),
    veil_up: hasBit(r.reasons, 7),
    stand_in_showing: hasBit(r.reasons, 8),
    held_ms: holdMilliseconds(r.heldMs),
    webkit_views: cappedCount(r.webkitViews),
    webkit_on_top: flag(r.webkitOnTop),
    still_unpainted: cappedCount(r.stillUnpainted),
    still_reasons: reasonBits(r.stillReasons),
    session_min: sessionMin,
  };
}
