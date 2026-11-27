import type { CornerRadii } from "./hostExtensionView.ts";
import { intersection, subtract, type Rect } from "./inputRegions.ts";

export const GLASS_METHOD = "shell.glassRegions";
export const GLASS_BEHIND_WINDOW = "shell.glassBehindWindow";
export const GLASS_MODULE = "ArdiaGlass";
const GLASS_BLUR = 24;
export const GLASS_MAX_REGIONS = 64;
export const STABLE_FRAMES = 2;
export const AFTERIMAGE_MS = 250;

export type GlassGeometry = { rect: Rect; radii: CornerRadii; opacity: number; scale?: number };
export type GlassMaterial = "regular" | "clear" | "sidebar" | "header" | "menu" | "popover" | "hud" | "window" | "underWindow";
export type GlassLook = { material?: GlassMaterial; tint?: string; group?: string; appearance?: "light" | "dark" };
type GlassRegion = { id: string; rect: Rect; radii: CornerRadii; blur: number; opacity: number } & GlassLook;
export type GlassOptions = { behindWindow?: boolean };
type GlassUpdate = { generation: number; regions: GlassRegion[] };
export type GlassApplied = { generation: number; available: boolean; accepted: string[] };
export type GlassHole = { slot: Element; rect: Rect; radii: CornerRadii };

type GlassDeps = {
  send: ((update: GlassUpdate) => Promise<GlassApplied>) | null;
  measure: (element: Element) => GlassGeometry | null;
  apply: (element: Element, translucent: boolean) => void;
  afterimage: (element: Element, geometry: GlassGeometry) => () => void;
  watch: (element: Element, changed: () => void) => () => void;
  animating: (element: Element) => boolean;
  frame: (run: () => void) => void;
  timeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  report?: (error: unknown) => void;
  activity?: (active: boolean) => void;
  availability?: (available: boolean) => void;
  holes?: (holes: readonly GlassHole[]) => void;
};

type Applied = { generation: number; key: string; accepted: boolean };
type Afterimage = { generation: number; remove: () => void; timer: unknown };

type Entry = {
  id: string;
  blur: number;
  look: GlassLook;
  geometry: GlassGeometry | null;
  key: string;
  stable: number;
  moving: boolean;
  pending: { generation: number; key: string } | null;
  applied: Applied | null;
  translucent: boolean;
  held: boolean;
  stop: () => void;
};

const round = (value: number) => Math.round(value * 100) / 100;
const keyOf = (geometry: GlassGeometry | null) =>
  geometry
    ? JSON.stringify([
        [geometry.rect.x, geometry.rect.y, geometry.rect.width, geometry.rect.height].map(round),
        [geometry.radii.upperLeft, geometry.radii.upperRight, geometry.radii.lowerRight, geometry.radii.lowerLeft].map(round),
        round(geometry.opacity),
        geometry.scale ?? 1,
      ])
    : "";
const lookOf = (look: GlassLook): GlassLook => ({
  ...(look.material ? { material: look.material } : {}),
  ...(look.tint ? { tint: look.tint } : {}),
  ...(look.group ? { group: look.group } : {}),
  ...(look.appearance ? { appearance: look.appearance } : {}),
});

export function offPagePieces(rect: Rect, radii: CornerRadii, pages: readonly Rect[]): { rect: Rect; radii: CornerRadii }[] {
  let pieces: Rect[] = [rect];
  for (const page of pages) pieces = pieces.flatMap((piece) => subtract(piece, page));
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return pieces.flatMap((piece) => {
    const pieceRight = piece.x + piece.width;
    const pieceBottom = piece.y + piece.height;
    const corner = (x: number, y: number, cornerX: number, cornerY: number, radius: number) => (near(x, cornerX) && near(y, cornerY) ? radius : 0);
    const kept = {
      rect: piece,
      radii: {
        upperLeft: corner(piece.x, piece.y, rect.x, rect.y, radii.upperLeft),
        upperRight: corner(pieceRight, piece.y, right, rect.y, radii.upperRight),
        lowerRight: corner(pieceRight, pieceBottom, right, bottom, radii.lowerRight),
        lowerLeft: corner(piece.x, pieceBottom, rect.x, bottom, radii.lowerLeft),
      },
    };
    const corners = [kept.radii.upperLeft, kept.radii.upperRight, kept.radii.lowerRight, kept.radii.lowerLeft];
    return corners.some((radius) => radius > piece.width / 2 + 0.01 || radius > piece.height / 2 + 0.01) ? [] : [kept];
  });
}

export function createGlassRegions(deps: GlassDeps, initiallyAvailable: boolean, options: GlassOptions = {}) {
  const entries = new Map<Element, Entry>();
  const afterimages = new Set<Afterimage>();
  let available = initiallyAvailable;
  let pages: readonly Rect[] = [];
  let nextId = 0;
  let generation = 0;
  let presented = 0;
  let frameQueued = false;
  let inFlight = false;
  let queued: GlassUpdate | null = null;
  let sentKey = "";
  let active = false;
  let holesKey = "";

  const syncActivity = () => {
    const now = available && entries.size > 0;
    if (now === active) return;
    active = now;
    deps.activity?.(now);
  };

  const nested = (element: Element) => {
    for (const other of entries.keys()) if (other !== element && other.contains(element)) return true;
    return false;
  };

  const overSurface = (rect: Rect) => options.behindWindow === true || pages.some((page) => intersection(rect, page));
  const eligible = (element: Element, entry: Entry) =>
    !!entry.geometry && entry.geometry.opacity > 0 && overSurface(entry.geometry.rect) && !nested(element);

  const setTranslucent = (element: Element, entry: Entry, translucent: boolean) => {
    if (entry.translucent === translucent) return;
    entry.translucent = translucent;
    deps.apply(element, translucent);
  };

  const evaluate = () => {
    for (const [element, entry] of entries) {
      const applied = entry.applied;
      const ready =
        available &&
        eligible(element, entry) &&
        !entry.moving &&
        entry.stable >= STABLE_FRAMES &&
        !!applied &&
        applied.accepted &&
        applied.key === entry.key &&
        presented >= applied.generation;
      setTranslucent(element, entry, ready);
    }
    for (const image of [...afterimages]) if (presented >= image.generation) dropAfterimage(image);
    publishHoles();
  };

  const publishHoles = () => {
    if (!deps.holes) return;
    const holes: GlassHole[] = [];
    for (const [element, entry] of entries) {
      const geometry = entry.geometry;
      if (!entry.translucent || !geometry) continue;
      for (const piece of offPagePieces(geometry.rect, geometry.radii, pages)) holes.push({ slot: element, ...piece });
    }
    const key = JSON.stringify(holes.map((hole) => [entries.get(hole.slot)!.id, hole.rect, hole.radii]));
    if (key === holesKey) return;
    holesKey = key;
    deps.holes(holes);
  };

  const dropAfterimage = (image: Afterimage) => {
    if (!afterimages.delete(image)) return;
    deps.clearTimeout(image.timer);
    image.remove();
  };

  const leaveBehind = (element: Element, entry: Entry) => {
    if (!entry.translucent || !entry.geometry) return;
    const image: Afterimage = { generation: Number.POSITIVE_INFINITY, remove: deps.afterimage(element, entry.geometry), timer: null };
    image.timer = deps.timeout(() => dropAfterimage(image), AFTERIMAGE_MS);
    afterimages.add(image);
  };

  const transmit = (update: GlassUpdate) => {
    if (inFlight) {
      queued = update;
      return;
    }
    inFlight = true;
    deps.send!(update)
      .then(
        (reply) => {
          if (!reply || reply.available === false) return setAvailable(false);
          const accepted = new Set(reply?.accepted ?? []);
          for (const entry of entries.values()) {
            if (entry.pending?.generation !== update.generation) continue;
            const accepting = accepted.has(entry.id);
            const unchanged = accepting && !!entry.applied?.accepted && entry.applied.key === entry.pending.key;
            entry.applied = { generation: unchanged ? entry.applied!.generation : update.generation, key: entry.pending.key, accepted: accepting };
            entry.pending = null;
          }
          evaluate();
        },
        (error) => {
          deps.report?.(error);
          for (const entry of entries.values()) if (entry.pending?.generation === update.generation) entry.pending = null;
          sentKey = "";
        },
      )
      .finally(() => {
        inFlight = false;
        const next = queued;
        queued = null;
        if (next) transmit(next);
      });
  };

  const nextFrame = () => {
    if (frameQueued) return;
    frameQueued = true;
    deps.frame(() => {
      frameQueued = false;
      flush();
    });
  };

  const flush = () => {
    if (!available) {
      for (const [element, entry] of entries) setTranslucent(element, entry, false);
      evaluate();
      return;
    }
    let unsettled = false;
    for (const [element, entry] of entries) {
      const geometry = deps.measure(element);
      const key = keyOf(geometry);
      entry.moving = deps.animating(element);
      if (key !== entry.key || entry.moving) {
        if (!geometry) leaveBehind(element, entry);
        entry.geometry = geometry;
        entry.key = key;
        entry.stable = 0;
        setTranslucent(element, entry, false);
      } else if (entry.stable < STABLE_FRAMES) entry.stable += 1;
      if (entry.held && entry.stable >= STABLE_FRAMES && !entry.moving) entry.held = false;
      if (entry.stable < STABLE_FRAMES || entry.moving) unsettled = true;
    }
    evaluate();
    if (unsettled) nextFrame();
    if (!deps.send || !available) return;
    const regions: GlassRegion[] = [];
    const included: Entry[] = [];
    for (const [element, entry] of entries) {
      if (!eligible(element, entry) || entry.held || regions.length >= GLASS_MAX_REGIONS) continue;
      const { rect, radii, opacity } = entry.geometry!;
      regions.push({ id: entry.id, rect, radii, blur: entry.blur, opacity, ...entry.look });
      included.push(entry);
    }
    for (const [element, entry] of entries) {
      if (included.includes(entry)) continue;
      entry.applied = null;
      entry.pending = null;
      setTranslucent(element, entry, false);
    }
    const key = JSON.stringify([regions, included.map((entry) => entry.geometry!.scale ?? 1)]);
    if (key === sentKey) return;
    sentKey = key;
    const update = { generation: ++generation, regions };
    for (const entry of included) entry.pending = { generation: update.generation, key: entry.key };
    for (const image of afterimages) if (image.generation === Number.POSITIVE_INFINITY) image.generation = update.generation;
    transmit(update);
  };

  const setAvailable = (value: boolean) => {
    if (available === value) return;
    available = value;
    sentKey = "";
    for (const entry of entries.values()) {
      entry.applied = null;
      entry.pending = null;
    }
    evaluate();
    nextFrame();
    syncActivity();
    deps.availability?.(value);
  };

  return {
    add(element: Element, blur = GLASS_BLUR, look: GlassLook = {}) {
      const entry: Entry = { id: `g${++nextId}`, blur, look: lookOf(look), geometry: null, key: "", stable: 0, moving: false, pending: null, applied: null, translucent: false, held: false, stop: () => {} };
      entries.set(element, entry);
      deps.apply(element, false);
      entry.stop = deps.watch(element, nextFrame);
      nextFrame();
      syncActivity();
      return () => {
        if (entries.get(element) !== entry) return;
        entry.stop();
        leaveBehind(element, entry);
        entries.delete(element);
        publishHoles();
        nextFrame();
        syncActivity();
      };
    },
    restyle(element: Element, look: GlassLook) {
      const entry = entries.get(element);
      if (!entry) return;
      const next = lookOf(look);
      if (JSON.stringify(next) === JSON.stringify(entry.look)) return;
      entry.look = next;
      nextFrame();
    },
    setPages(rects: readonly Rect[]) {
      pages = rects;
      publishHoles();
      nextFrame();
    },
    motion(target: Element, scrolling = false) {
      let moved = false;
      for (const [element, entry] of entries) {
        if (!target.contains(element)) continue;
        entry.stable = 0;
        if (scrolling) entry.held = true;
        setTranslucent(element, entry, false);
        moved = true;
      }
      if (moved) nextFrame();
    },
    presented(value: number) {
      if (!Number.isFinite(value) || value <= presented || value > generation) return;
      presented = value;
      evaluate();
    },
    setAvailable,
    available: () => available,
    refresh: nextFrame,
    flushNow: flush,
    behindWindow: () => options.behindWindow === true,
    status: () => ({
      available,
      generation,
      presented,
      panels: [...entries.values()].map((entry) => ({ id: entry.id, translucent: entry.translucent, stable: entry.stable, applied: entry.applied, geometry: entry.geometry })),
      afterimages: afterimages.size,
    }),
  };
}

export type GlassRegistry = ReturnType<typeof createGlassRegions>;
