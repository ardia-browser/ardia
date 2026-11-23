import type { Rect } from "../window/geometry";

export function handlePosition(rect: Rect, topOffset: number, inset: number): { left: number; top: number } {
  return { left: rect.x + inset, top: rect.y + topOffset + inset };
}

export function paneAtPoint(panes: Record<string, Rect>, x: number, y: number, excludeId: string): string | null {
  for (const [tabId, rect] of Object.entries(panes)) {
    if (tabId === excludeId) continue;
    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) return tabId;
  }
  return null;
}

export function clampHandleOffset(left: number, top: number, bounds: { width: number; height: number }, size: number): { left: number; top: number } {
  return {
    left: Math.max(0, Math.min(Math.max(0, bounds.width - size), left)),
    top: Math.max(0, Math.min(Math.max(0, bounds.height - size), top)),
  };
}
