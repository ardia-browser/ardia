import type { Rect4, WindowEvent, WindowGeometry, WindowsNative } from "@ardia/shell";

export const windowGeometries = new Map<string, WindowGeometry>();

export const geometryWorld = { screens: [[0, 0, 1920, 1080]] as Rect4[], transitionMs: 0, stalls: false };

const transitions = new Map<string, () => void>();

export function finishStalledTransition(id: string) {
  transitions.get(id)?.();
}

export function beginWindowControlTransition(id: string, on: boolean, emit: (event: WindowEvent) => void) {
  const g = windowGeometries.get(id);
  transitions.set(id, () => {
    transitions.delete(id);
    if (g) g.fullScreen = on;
    emit({ type: "fullScreen", id, on });
  });
}

type GeometryFakes = Pick<WindowsNative, "windowGeometry" | "setWindowFrame" | "setWindowZoomed" | "setWindowFullScreen">;

const overlaps = (a: Rect4, b: Rect4) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

export function windowGeometryFakes(isOpen: (id: string) => boolean, emit: (event: WindowEvent) => void): GeometryFakes {
  const of = (id: string): WindowGeometry | null => {
    if (!isOpen(id)) return null;
    if (!windowGeometries.has(id)) windowGeometries.set(id, { frame: [100, 100, 1200, 800], zoomed: false, fullScreen: false, miniaturized: false, visible: true, display: null });
    return windowGeometries.get(id)!;
  };
  const copy = (g: WindowGeometry | null) => (g ? { ...g, frame: [...g.frame] as Rect4 } : null);
  return {
    windowGeometry: (id) => Promise.resolve(copy(of(id))),
    setWindowFrame: (id, frame) => {
      const g = of(id);
      if (!g || g.fullScreen) return Promise.resolve(copy(g));
      if (!frame.every(Number.isFinite) || frame[2] <= 0 || frame[3] <= 0) return Promise.resolve({ ...copy(g)!, refused: "invalid" as const });
      if (!geometryWorld.screens.some((screen) => overlaps(screen, frame))) return Promise.resolve({ ...copy(g)!, refused: "offscreen" as const });
      Object.assign(g, { frame: [...frame], zoomed: false });
      return Promise.resolve(copy(g));
    },
    setWindowZoomed: (id, on) => {
      const g = of(id);
      if (g && !g.fullScreen) g.zoomed = on;
      return Promise.resolve(copy(g));
    },
    setWindowFullScreen: (id, on) => {
      if (transitions.has(id)) return Promise.resolve({ ...copy(of(id))!, transition: "busy" as const });
      const g = of(id);
      if (!g || g.fullScreen === on || g.pageFullScreen) return Promise.resolve(copy(g));
      const end = () => {
        transitions.delete(id);
        g.fullScreen = on;
        emit({ type: "fullScreen", id, on });
      };
      transitions.set(id, end);
      if (geometryWorld.stalls) return new Promise((resolve) => setTimeout(() => resolve({ ...copy(g)!, transition: "timeout" as const }), geometryWorld.transitionMs));
      return new Promise((resolve) =>
        setTimeout(() => {
          end();
          resolve(copy(g));
        }, geometryWorld.transitionMs),
      );
    },
  };
}
