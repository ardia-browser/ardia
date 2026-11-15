import { screen } from "electron";
import { defineModule, emit } from "../bridge";
import { appWindow } from "../windows";

const MODULE = "ArdiaLinuxEdgePointer";
const POLL_MS = 30;

type Point = { x: number; y: number } | null;

const watched = new Map<string, Point>();
let timer: ReturnType<typeof setInterval> | null = null;

function pointIn(id: string): Point {
  const window = appWindow(id);
  if (!window || window.isDestroyed() || !window.isVisible() || window.isMinimized()) return null;
  const cursor = screen.getCursorScreenPoint();
  const bounds = window.getContentBounds();
  const x = cursor.x - bounds.x;
  const y = cursor.y - bounds.y;
  if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return null;
  return { x, y };
}

const samePoint = (a: Point, b: Point) => (a === null || b === null ? a === b : a.x === b.x && a.y === b.y);

function poll() {
  for (const [id, last] of watched) {
    const now = pointIn(id);
    if (samePoint(now, last)) continue;
    watched.set(id, now);
    emit(MODULE, "point", { id, point: now ? [now.x, now.y] : null });
  }
}

function watch(id: string, on: boolean) {
  if (on) watched.set(id, watched.get(id) ?? null);
  else watched.delete(id);
  if (watched.size && !timer) timer = setInterval(poll, POLL_MS);
  if (!watched.size && timer) {
    clearInterval(timer);
    timer = null;
  }
}

defineModule(MODULE, {
  async: { watch: async (id: string, on: boolean) => watch(id, on) },
});
