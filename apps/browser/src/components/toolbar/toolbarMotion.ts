import type { ToolbarMode } from "../../state/windows/toolbarAutoHide";

export type MotionValue = "page" | "laid" | "bar" | "fade";
type MotionStep = {
  set: Partial<Record<MotionValue, number>>;
  glide: Partial<Record<MotionValue, number>>;
  show: boolean;
  fit: "now" | "afterGlide" | null;
};

const collapsedIn = (mode: ToolbarMode) => mode !== "shown";
const hiddenIn = (mode: ToolbarMode) => mode === "collapsed";

export function motionStep(from: ToolbarMode, to: ToolbarMode, reduce: boolean): MotionStep | null {
  const collapsed = collapsedIn(to);
  const hidden = hiddenIn(to);
  if (collapsedIn(from) !== collapsed) {
    const page = collapsed ? 1 : 0;
    const bar = hidden ? 1 : 0;
    const show = !collapsed;
    if (reduce) return { set: { laid: page, page, bar }, glide: { fade: bar }, show, fit: show ? "now" : null };
    return { set: { laid: page }, glide: { page, bar, fade: bar }, show, fit: show ? "afterGlide" : null };
  }
  if (hiddenIn(from) === hidden) return null;
  if (!hidden) return { set: { bar: 0, fade: 0 }, glide: {}, show: false, fit: null };
  if (reduce) return { set: { bar: 1 }, glide: { fade: 1 }, show: false, fit: null };
  return { set: {}, glide: { bar: 1, fade: 1 }, show: false, fit: null };
}

export function restStep(mode: ToolbarMode): MotionStep {
  const page = collapsedIn(mode) ? 1 : 0;
  const bar = hiddenIn(mode) ? 1 : 0;
  return { set: { laid: page, page, bar, fade: bar }, glide: {}, show: !page, fit: page ? null : "now" };
}

export type TallPage = { on: boolean; doc: string };

export function tallPage(was: TallPage, { enabled, collapsed, doc }: { enabled: boolean; collapsed: boolean; doc: string }): TallPage {
  const kept = was.doc !== doc || (!enabled && was.on) ? { on: false, doc } : was;
  return enabled && collapsed && !kept.on ? { on: true, doc } : kept;
}

export type PageCover = { room: number; perPage: number; perBar: number };

export function pageCover({ row, extra, strip }: { row: number; extra: number; strip: number }): PageCover {
  const room = row + extra - strip;
  return { room, perPage: room, perBar: strip - row };
}
