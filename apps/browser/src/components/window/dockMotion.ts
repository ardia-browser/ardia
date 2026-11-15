import { layout } from "../ui/theme";
import { DOCK_SLIDE, DOCK_SLIDE_CURVE } from "./tokens";
import type { SpringSpec } from "../ui/motion";

export const easeOutCubic = (u: number) => 1 - (1 - u) ** 3;
export const easeInOutCubic = (u: number) => (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2);

export function springAt(t: number, { response, damping }: SpringSpec): number {
  if (t <= 0) return 0;
  const omega = (2 * Math.PI) / response;
  const wd = omega * Math.sqrt(1 - damping * damping);
  return 1 - Math.exp(-damping * omega * t) * (Math.cos(wd * t) + ((damping * omega) / wd) * Math.sin(wd * t));
}

export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (u: number) => number {
  const at = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  return (u) => {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      if (at(x1, x2, mid) < u) lo = mid;
      else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}

const slideCurve = cubicBezier(...DOCK_SLIDE_CURVE);

export const slideAt = (seconds: number) => slideCurve((seconds * 1000) / DOCK_SLIDE.duration);

export const sidebarCardGap = (inset: number) => Math.max(0, inset - layout.sidebarInset);

export const dockedCardInset = (sidebarWidth: number, inset: number) => sidebarWidth + sidebarCardGap(inset);

export const cardInsetAt = (dock: number, sidebarWidth: number, inset: number) => inset + (dockedCardInset(sidebarWidth, inset) - inset) * dock;

export const HEADER_TOOLS = { toggleX: 70.75 + 27, fullScreenToggleX: 29, pitch: 35, edge: layout.sidebarInset + 1 } as const;

export type HeaderButton = "back" | "forward" | "reload";

export function headerToggleX(windowFullScreen: boolean): number {
  return windowFullScreen ? HEADER_TOOLS.fullScreenToggleX : HEADER_TOOLS.toggleX;
}

export function navButtonsFitting(width: number, button = 30, toggle = true, toggleX: number = HEADER_TOOLS.toggleX): { buttons: HeaderButton[]; step: number } {
  const { pitch, edge } = HEADER_TOOLS;
  const span = width - edge - button / 2 - (toggle ? toggleX : toggleX - pitch);
  const count = Math.max(0, Math.min(3, Math.floor(span / button)));
  const buttons: HeaderButton[] = count === 3 ? ["back", "forward", "reload"] : count === 2 ? ["back", "forward"] : count === 1 ? ["back"] : [];
  return { buttons, step: count ? Math.min(pitch, span / count) : pitch };
}

export const PEEK_EDGE_STRIP = 3;
export const TAB_DRAG_EDGE_STRIP = 8;
export const PEEK_HOLD_SLACK = 40;
export const PEEK_CLOSE_DELAY_MS = 200;
export const PEEK_BLEED = 16;

export const peekBleed = (peekLeft: number) => (peekLeft > 0 ? 0 : PEEK_BLEED);

export type DockState = "fullscreen" | "docked" | "peeking" | "leaving" | "hiding" | "away";
export type DockInput = { open: boolean; fullscreen: boolean; moving: boolean; peekLive: boolean; peekLeaving?: boolean };

export function dockState({ open, fullscreen, moving, peekLive, peekLeaving = false }: DockInput): DockState {
  if (fullscreen) return "fullscreen";
  if (open) return "docked";
  if (peekLive) return peekLeaving ? "leaving" : "peeking";
  return moving ? "hiding" : "away";
}

export const peekOnScreen = (state: DockState) => state === "peeking" || state === "leaving";

export const shownAs = (state: DockState) => (peekOnScreen(state) ? "peek" : state === "hiding" ? "away" : state);

export const watchesEdge = (state: DockState, moving: boolean) => (peekOnScreen(state) || state === "away") && !moving;

export const atRevealEdge = (x: number, right: boolean, windowWidth: number, band: number = PEEK_EDGE_STRIP) => (right ? x >= windowWidth - band : x < band);

export const edgeEventReveals = (state: DockState, x: number, right: boolean, windowWidth: number, band: number = PEEK_EDGE_STRIP) =>
  state === "peeking" || atRevealEdge(x, right, windowWidth, band);

export type EdgeSource = "strip" | "native";
export type EdgeArm = { armed: boolean; strip: boolean; native: boolean };
export const EDGE_ARMED: EdgeArm = { armed: true, strip: false, native: false };
export const EDGE_DISARMED: EdgeArm = { armed: false, strip: false, native: false };

export function edgeSeen(arm: EdgeArm, source: EdgeSource, over: boolean): EdgeArm {
  const next = { ...arm, [source]: over };
  return next.strip || next.native ? next : { ...next, armed: true };
}

export const edgeClosed = (arm: EdgeArm): EdgeArm => ({ ...arm, armed: !arm.strip && !arm.native });

export const peekHoldWidth = (sidebarWidth: number, peekLeft: number) => peekLeft + sidebarWidth + PEEK_HOLD_SLACK;

export const peekSpan = (sidebarWidth: number, right: boolean, windowWidth: number, peekLeft: number): readonly [number, number] =>
  right ? [windowWidth - peekLeft - sidebarWidth, Infinity] : [-Infinity, peekLeft + sidebarWidth];

export const edgeWatchWidth = (peeking: boolean, draggingTab: boolean, holdWidth: number, inset: number) =>
  peeking ? holdWidth : draggingTab ? TAB_DRAG_EDGE_STRIP : edgeStripOverPage(inset) ? PEEK_EDGE_STRIP : 0;

export const edgeStripOverPage = (inset: number) => inset < PEEK_EDGE_STRIP;

export type DockMove = "jump" | "arcHide" | "slide";

export function dockMove(o: { open: boolean; animated: boolean; arc: boolean; peekOut: boolean }): DockMove {
  if (!o.animated || (o.arc && o.open && o.peekOut)) return "jump";
  return o.arc && !o.open ? "arcHide" : "slide";
}
