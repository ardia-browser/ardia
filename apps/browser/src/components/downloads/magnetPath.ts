import { SIDEBAR_FOOTER_DOWNLOADS } from "../sidebar/geometry";
import { MAGNET } from "./tokens";

export type MagnetPoint = { x: number; y: number };

export type MagnetLayout = {
  width: number;
  height: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
  right: boolean;
  topStrip: boolean;
  footer: boolean;
  lightsY: number;
};

export type MagnetPath = { start: MagnetPoint; target: MagnetPoint; arc: number; fromPageEdge: boolean };

export function magnetTarget({ width, height, sidebarOpen, sidebarWidth, right, topStrip, footer, lightsY }: MagnetLayout): MagnetPoint {
  const sidebarLeft = right ? width - sidebarWidth : 0;
  if (topStrip) return { x: width - MAGNET.topStripTarget.right, y: MAGNET.topStripTarget.y };
  if (footer) return { x: sidebarLeft + SIDEBAR_FOOTER_DOWNLOADS.left + SIDEBAR_FOOTER_DOWNLOADS.size / 2, y: height - SIDEBAR_FOOTER_DOWNLOADS.bottom - SIDEBAR_FOOTER_DOWNLOADS.size / 2 };
  if (sidebarOpen) return { x: sidebarLeft + sidebarWidth - MAGNET.sidebarTarget.right, y: lightsY };
  return right ? { x: width - MAGNET.closedTarget.x, y: MAGNET.closedTarget.y } : MAGNET.closedTarget;
}

export function magnetPath(layout: MagnetLayout, fromPageEdge: boolean): MagnetPath {
  const { width, height, sidebarOpen, sidebarWidth, right, topStrip } = layout;
  const target = magnetTarget(layout);
  const sidebar = !topStrip && sidebarOpen ? sidebarWidth : 0;
  const pageCentre = { x: (right ? 0 : sidebar) + (width - sidebar) / 2, y: height * MAGNET.startShare };
  if (!fromPageEdge) return { start: pageCentre, target, arc: MAGNET.arc, fromPageEdge: false };
  if (sidebar > 0) {
    const reach = (MAGNET.icon * MAGNET.peakScale) / 2 + MAGNET.pageEdgeGap;
    const sidebarLeft = right ? width - sidebarWidth : 0;
    const x = right ? sidebarLeft + Math.min(reach, sidebarWidth / 2) : sidebarLeft + sidebarWidth - Math.min(reach, sidebarWidth / 2);
    return { start: { x, y: pageCentre.y }, target, arc: MAGNET.arc, fromPageEdge: true };
  }
  return { start: { x: pageCentre.x, y: target.y }, target, arc: 0, fromPageEdge: true };
}

export function magnetPoint({ start, target, arc }: MagnetPath, progress: number): MagnetPoint {
  return { x: start.x + (target.x - start.x) * progress, y: start.y + (target.y - start.y) * progress - Math.sin(Math.PI * progress) * arc };
}
