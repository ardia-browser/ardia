type Point = readonly [number, number];

const REAR_CLOSED: readonly Point[] = [[26, 88], [26, 21], [30, 18], [54, 18], [66, 26], [92, 26], [96, 30], [96, 88]];
const REAR_OPEN: readonly Point[] = [[31, 88], [15, 31], [19, 28], [37, 28], [47, 34], [67, 34], [71, 38], [91, 88]];
const FRONT_CLOSED: readonly Point[] = [[26, 36], [96, 36], [96, 88], [26, 88]];
const FRONT_OPEN: readonly Point[] = [[48.61, 43], [106.65, 43], [91, 88], [31, 88]];
const REAR_CORNER_RADIUS = 8;
const FRONT_CORNER_RADIUS = 9;
export const STROKE_WIDTH = 8;
export const HINGE_Y = 88;
const CLOSED_CENTER: Point = [61, 53];
const UNITS_PER_SIDE = 81;
export const BLEED = 0.25;
export const DURATION_MS = 200;

export const FOLDER_PALETTE = { stroke: "#443AFF", face: "#F4F3FF", insideTop: "#BFBCFF", insideBottom: "#8781FF" } as const;

const ART_UNITS = UNITS_PER_SIDE * (1 + 2 * BLEED);
export const VIEW_BOX = `${CLOSED_CENTER[0] - ART_UNITS / 2} ${CLOSED_CENTER[1] - ART_UNITS / 2} ${ART_UNITS} ${ART_UNITS}`;

export const smoothstep = (p: number) => p * p * (3 - 2 * p);

const mix = (a: readonly Point[], b: readonly Point[], u: number): Point[] => a.map(([x, y], i) => [x + (b[i]![0] - x) * u, y + (b[i]![1] - y) * u]);

const round = (n: number) => Math.round(n * 1000) / 1000;

export function roundedPath(points: readonly Point[], radius: number): string {
  const parts: string[] = [];
  points.forEach(([vx, vy], i) => {
    const [px, py] = points[(i + points.length - 1) % points.length]!;
    const [nx, ny] = points[(i + 1) % points.length]!;
    const d1 = Math.hypot(px - vx, py - vy);
    const d2 = Math.hypot(nx - vx, ny - vy);
    const a = Math.min(radius, d1 / 3) / d1;
    const b = Math.min(radius, d2 / 3) / d2;
    const before = `${round(vx + (px - vx) * a)} ${round(vy + (py - vy) * a)}`;
    parts.push(`${i === 0 ? "M" : "L"}${before}Q${round(vx)} ${round(vy)} ${round(vx + (nx - vx) * b)} ${round(vy + (ny - vy) * b)}`);
  });
  return `${parts.join("")}Z`;
}

export function folderShapes(progress: number) {
  const u = smoothstep(Math.min(1, Math.max(0, progress)));
  const rear = mix(REAR_CLOSED, REAR_OPEN, u);
  return {
    rear: roundedPath(rear, REAR_CORNER_RADIUS),
    front: roundedPath(mix(FRONT_CLOSED, FRONT_OPEN, u), FRONT_CORNER_RADIUS),
    top: Math.min(...rear.map(([, y]) => y)),
  };
}
