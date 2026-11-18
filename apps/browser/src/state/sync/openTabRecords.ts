import { TAB_GROUP_COLORS } from "@ardia/core";
import { isFields, isNumber, isString } from "../../lib/decode";
import type { GroupColor } from "../browser/types";

export const OPEN_TABS = "otab:";
export const OPEN_TAB = "otab:t:";
export const OPEN_GROUP = "otab:g:";
export const OPEN_TABS_ON = "otab:on";

export type OpenTabValue = { u: string; t: string; pos: string; g: string | null; a: number };
export type OpenGroupValue = { n: string; i: string | null; c: GroupColor | null; p: string | null };

const GROUP_COLORS = new Set<unknown>([...TAB_GROUP_COLORS, "none"]);

export const syncsAsOpenTab = (url: string) => /^https?:\/\//i.test(url);

export function openTabValue(v: unknown): OpenTabValue | null {
  if (!isFields(v) || !isString(v.u) || !syncsAsOpenTab(v.u) || !isString(v.pos) || !v.pos) return null;
  return { u: v.u, t: isString(v.t) ? v.t : "", pos: v.pos, g: isString(v.g) ? v.g : null, a: isNumber(v.a) ? v.a : 0 };
}

export const openTabsOn = (v: unknown): boolean | null => (isFields(v) && typeof v.on === "boolean" ? v.on : null);

export function openGroupValue(v: unknown): OpenGroupValue | null {
  if (!isFields(v)) return null;
  return {
    n: isString(v.n) ? v.n : "",
    i: isString(v.i) ? v.i : null,
    c: GROUP_COLORS.has(v.c) ? (v.c as GroupColor) : null,
    p: isString(v.p) ? v.p : null,
  };
}
