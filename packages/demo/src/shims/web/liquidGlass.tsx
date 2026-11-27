/* MIT License - Copyright (c) 2026 Bilal Abdullah Gürşen. Adapted from glass-layer.tsx of https://github.com/bilalgursen/liquid-glass; see third_party/liquid-glass/LICENSE. */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { drawAround, drawDom } from "../../../../../third_party/liquid-glass/dom-snapshot";
import { DESIGN_HEIGHT, MIRROR, clamp, getGlassEngine, onGlassEngineChange, rgbCss, surfaceColorOf, type GlassEngine, type GlassLens, type GlassView, type Rgb } from "../../../../../third_party/liquid-glass/engine";
import { GLASS_OPTICS, RIM_MIRROR, rgb, tintedGlass, type GlassOptics, type LiquidGlassStyle, type LiquidGlassTheme } from "./liquidGlassOptics";
import { fixedBehind, ownControl, ownOpacity } from "./liquidGlassPlace";

const PAD_SIDE = 8;
const PAD_TOP = 10;
const PAGE_REFRESH_MS = 120;
const MOVE_CHECK_MS = 16;
const MOVE_TOLERANCE_PX = 0.25;
const layer: CSSProperties = { position: "absolute", inset: 0, pointerEvents: "none" };
const canvasStyle: CSSProperties = { position: "absolute", pointerEvents: "none", maxWidth: "none", width: 0, height: 0 };

export type GlassMount = { invalidate: () => void; repaint: () => void; watchMove: () => void; suspend: () => void; reattach: () => void; stop: () => void; view: GlassView };

const mounted = new Set<GlassMount>();
const PAGE_EVENTS = { capture: true, passive: true } as const;
let pageWatched = false;
let stopEngineWatch: (() => void) | null = null;

export function invalidateLiquidGlass() {
  for (const glass of mounted) glass.invalidate();
}

export function liquidGlassMoving() {
  for (const glass of mounted) glass.watchMove();
}

function repaintLiquidGlass() {
  for (const glass of mounted) glass.repaint();
}

function watchPage(on: boolean) {
  if (pageWatched === on) return;
  pageWatched = on;
  const toggle = on ? "addEventListener" : "removeEventListener";
  document[toggle]("transitionend", invalidateLiquidGlass, PAGE_EVENTS);
  document[toggle]("animationend", invalidateLiquidGlass, PAGE_EVENTS);
  window[toggle]("scroll", repaintLiquidGlass, PAGE_EVENTS);
}

function engineChanged(change: "lost" | "restored") {
  watchPage(change === "restored" && mounted.size > 0);
  for (const glass of mounted) {
    if (change === "lost") glass.suspend();
    else glass.reattach();
  }
}

function track(glass: GlassMount, on: boolean) {
  if (on) mounted.add(glass);
  else mounted.delete(glass);
  if (mounted.size && !stopEngineWatch) {
    Object.assign(MIRROR, RIM_MIRROR);
    stopEngineWatch = onGlassEngineChange(engineChanged);
    watchPage(true);
  } else if (!mounted.size && stopEngineWatch) {
    stopEngineWatch();
    stopEngineWatch = null;
    watchPage(false);
  }
}

type Look = { optics: GlassOptics; tint: string | undefined };

export function mountGlass(host: HTMLDivElement, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, look: { current: Look }, onReady: (ready: boolean) => void, acquire: () => GlassEngine | null = getGlassEngine): GlassMount | null {
  const first = acquire();
  if (!first) return null;
  let engine: GlassEngine = first;
  let w = 0;
  let h = 0;
  let corner: number | null = null;
  let surface: Rgb = [1, 1, 1];
  let color: Rgb = [1, 1, 1];
  let frost = 0;
  let border: Rgb | undefined;
  let borderAlpha = 0;
  let own: Element = host;
  let faded = 1;
  let ready = false;
  let drawnAt: DOMRect | null = null;
  let settling = 0;
  const page = { canvas: document.createElement("canvas"), ctx: null as CanvasRenderingContext2D | null, key: "", at: 0, stale: true, fill: "" };
  const skip = (el: Element) => el === own || el === host || el.hasAttribute("data-glass-skip") || fixedBehind(el, own);
  const dirty = () => {
    view.dirty = true;
    engine.wake();
  };
  const invalidate = () => {
    page.stale = true;
    dirty();
  };
  const stale = () => {
    page.stale = true;
    dirty();
  };
  const refresh = () => {
    w = host.offsetWidth;
    h = host.offsetHeight;
    const rounding = getComputedStyle(host).borderTopLeftRadius;
    const px = rounding.endsWith("%") ? (Math.min(w, h) * parseFloat(rounding)) / 100 : parseFloat(rounding) || 0;
    corner = px >= Math.min(w, h) / 2 - 0.5 ? null : px;
    own = ownControl(host);
    faded = ownOpacity(host, own);
    surface = rgb(engine.resolveColor(surfaceColorOf(own.parentElement ?? host.parentElement)));
    const { optics, tint } = look.current;
    const tinted = tintedGlass(rgb(engine.resolveColor(optics.tintColor)), optics.frost, tint ? engine.resolveColor(tint) : null);
    color = tinted.color;
    frost = tinted.frost;
    const line = optics.borderAlpha > 0 ? engine.resolveColor(optics.borderColor) : null;
    border = line ? rgb(line) : undefined;
    borderAlpha = line ? clamp(optics.borderAlpha * line[3]) : 0;
    page.stale = true;
  };
  const paint = (back: CanvasRenderingContext2D) => {
    back.translate(PAD_SIDE, PAD_TOP);
    const fill = rgbCss(surface);
    const recoloured = fill !== page.fill;
    page.fill = fill;
    back.fillStyle = fill;
    back.fillRect(-PAD_SIDE, -PAD_TOP, w + 2 * PAD_SIDE, h + 2 * PAD_TOP);
    const r = host.getBoundingClientRect();
    const lx = r.left + (r.width - w) / 2;
    const ly = r.top + (r.height - h) / 2;
    const target = back.canvas;
    const key = `${target.width}:${target.height}:${Math.round(lx * 2)}:${Math.round(ly * 2)}`;
    const now = performance.now();
    page.ctx ??= page.canvas.getContext("2d");
    const again = !!page.ctx && (page.stale || key !== page.key || now - page.at > PAGE_REFRESH_MS);
    if (page.ctx && again) {
      page.stale = false;
      page.key = key;
      page.at = now;
      if (page.canvas.width !== target.width || page.canvas.height !== target.height) {
        page.canvas.width = target.width;
        page.canvas.height = target.height;
      }
      const pc = page.ctx;
      pc.setTransform(1, 0, 0, 1, 0, 0);
      pc.clearRect(0, 0, target.width, target.height);
      pc.setTransform(back.getTransform());
      drawDom(pc, document.body, {
        origin: { left: lx, top: ly },
        region: { left: lx - PAD_SIDE, top: ly - PAD_TOP, right: lx + w + PAD_SIDE, bottom: ly + h + PAD_TOP },
        skip,
        onStale: stale,
      });
    }
    back.save();
    back.setTransform(1, 0, 0, 1, 0, 0);
    back.drawImage(page.canvas, 0, 0);
    back.restore();
    return again || recoloured;
  };
  const lens = (fresh: boolean): GlassLens | null => {
    if (fresh) refresh();
    if (w < 2 || h < 2) return null;
    const { optics: o } = look.current;
    const rect = host.getBoundingClientRect();
    const unit = h / DESIGN_HEIGHT;
    const bevel = DESIGN_HEIGHT * 0.42;
    const radius = corner === null ? 999 : corner;
    const strength = Math.max(clamp(o.light, 0, 3), 1e-4);
    return {
      left: -PAD_SIDE - host.clientLeft,
      top: -PAD_TOP - host.clientTop,
      width: w + 2 * PAD_SIDE,
      height: h + 2 * PAD_TOP,
      unit,
      cx: PAD_SIDE + w / 2,
      cy: PAD_TOP + h / 2,
      hx: w / 2,
      hy: h / 2,
      radius,
      bodyX: 0,
      bevel: (corner === null ? bevel : Math.min(bevel, (radius / unit) * 1.2)) * Math.max(0.05, o.bevel),
      band: corner === null ? undefined : bevel * 0.35 * Math.max(0.05, o.bevel),
      shadow: (0.12 * 0.55 * Math.max(0, o.shadowOpacity)) / strength,
      shadowSoftness: 34 * 0.6,
      shadowOffset: 22 * 0.5,
      strength,
      tune: { rim: o.rim / faded, rimWidth: o.rimWidth, fresnel: o.fresnel / faded, inner: o.inner, reflection: o.reflection, caustic: o.caustic, mirror: o.mirror, saturation: o.saturation },
      color,
      border,
      borderAlpha,
      borderWidth: 1,
      surface,
      edgeClear: 0.2,
      cursorLight: false,
      rimLight: { angle: o.rimAngle, lean: o.rimLean },
      pointerLight: true,
      reflection: {
        height: h,
        paint: (around, reach) => {
          const r = host.getBoundingClientRect();
          drawAround(around, document.body, { left: r.left + (r.width - w) / 2 - PAD_SIDE, top: r.top + (r.height - h) / 2 - PAD_TOP, width: w + 2 * PAD_SIDE, height: h + 2 * PAD_TOP }, reach, { skip, onStale: stale });
        },
      },
      refraction: {
        paint,
        refract: 44 * Math.max(0, o.refraction),
        magnify: 0,
        dispersion: Math.max(0, o.dispersion),
        blurCenter: Math.max(0, o.clearBlur),
        blurEdge: Math.max(0, o.clearBlurEdge),
        frost,
        blur: o.blur,
      },
      screenX: rect.left + rect.width / 2,
      screenY: rect.top + rect.height / 2,
      scale: rect.width / Math.max(w, 1e-3),
    };
  };
  const movedSinceDrawn = () => {
    if (!drawnAt) return false;
    const r = host.getBoundingClientRect();
    return Math.abs(r.left - drawnAt.left) > MOVE_TOLERANCE_PX || Math.abs(r.top - drawnAt.top) > MOVE_TOLERANCE_PX || Math.abs(r.width - drawnAt.width) > MOVE_TOLERANCE_PX || Math.abs(r.height - drawnAt.height) > MOVE_TOLERANCE_PX;
  };
  const settle = () => {
    settling = 0;
    if (movedSinceDrawn()) invalidate();
  };
  const watchMove = () => {
    if (drawnAt) settling ||= window.setTimeout(settle, MOVE_CHECK_MS);
  };
  const view: GlassView = {
    canvas,
    ctx,
    dirty: true,
    visible: false,
    step: () => false,
    lens,
    drawn: () => {
      drawnAt = host.getBoundingClientRect();
      watchMove();
      if (ready) return;
      ready = true;
      onReady(true);
    },
    lost: () => {
      drawnAt = null;
      ready = false;
      onReady(false);
    },
  };
  const io = new IntersectionObserver((entries) => {
    view.visible = entries.some((entry) => entry.isIntersecting);
    dirty();
  });
  const ro = new ResizeObserver(dirty);
  let trailing = 0;
  const observe = (on: boolean) => {
    if (on) {
      io.observe(host);
      ro.observe(host);
      return;
    }
    io.disconnect();
    ro.disconnect();
    if (trailing) window.clearTimeout(trailing);
    trailing = 0;
    if (settling) window.clearTimeout(settling);
    settling = 0;
    drawnAt = null;
  };
  observe(true);
  engine.add(view);
  const glass: GlassMount = {
    view,
    invalidate,
    watchMove,
    repaint: () => {
      view.repaint = true;
      engine.wake();
      trailing ||= window.setTimeout(() => {
        trailing = 0;
        invalidate();
      }, PAGE_REFRESH_MS);
    },
    suspend: () => observe(false),
    reattach: () => {
      const next = acquire();
      if (!next || next === engine) return;
      engine = next;
      observe(true);
      next.add(view);
      invalidate();
    },
    stop: () => {
      track(glass, false);
      engine.remove(view);
      observe(false);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
  track(glass, true);
  return glass;
}

export type GlassAttachment = { invalidate: () => void; stop: () => void; mounted: () => boolean };

export function attachGlass(host: HTMLDivElement, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, look: { current: Look }, onReady: (ready: boolean) => void, acquire: () => GlassEngine | null = getGlassEngine): GlassAttachment {
  let mount = mountGlass(host, canvas, ctx, look, onReady, acquire);
  let stopWaiting: (() => void) | null = mount
    ? null
    : onGlassEngineChange((change) => {
        if (change !== "restored" || mount) return;
        mount = mountGlass(host, canvas, ctx, look, onReady, acquire);
        if (!mount) return;
        stopWaiting?.();
        stopWaiting = null;
      });
  return {
    invalidate: () => mount?.invalidate(),
    mounted: () => !!mount,
    stop: () => {
      stopWaiting?.();
      stopWaiting = null;
      mount?.stop();
      mount = null;
    },
  };
}

export type LiquidGlassLayerProps = {
  theme: LiquidGlassTheme;
  glassStyle: LiquidGlassStyle;
  cornerRadius: number;
  radius: CSSProperties["borderRadius"];
  tint?: string;
  opacity?: number;
  enabled: boolean;
  backdropKey?: string;
  fallback: ReactNode;
  hostRef?: (node: HTMLDivElement | null) => void;
  hostProps?: Record<string, string>;
};

export function LiquidGlassLayer({ theme, glassStyle, cornerRadius, radius, tint, opacity, enabled, backdropKey, fallback, hostRef, hostProps }: LiquidGlassLayerProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(false);
  const look = useRef<Look>({ optics: GLASS_OPTICS[theme][glassStyle], tint });
  look.current = { optics: GLASS_OPTICS[theme][glassStyle], tint };
  const glass = useRef<GlassAttachment | null>(null);
  useLayoutEffect(() => {
    const node = host.current;
    const surface = canvas.current;
    const ctx = enabled ? surface?.getContext("2d") : null;
    if (!node || !surface || !ctx) return;
    const attachment = attachGlass(node, surface, ctx, look, setReady);
    glass.current = attachment;
    return () => {
      attachment.stop();
      glass.current = null;
      setReady(false);
    };
  }, [enabled]);
  useEffect(() => glass.current?.invalidate(), [theme, glassStyle, cornerRadius, tint, backdropKey]);
  const shown = enabled && ready;
  return (
    <div
      {...hostProps}
      ref={(node) => {
        host.current = node;
        hostRef?.(node);
      }}
      data-ardia-liquid-glass={shown ? "ready" : ""}
      style={{ ...layer, borderRadius: radius, opacity }}
    >
      {enabled ? <canvas ref={canvas} aria-hidden style={canvasStyle} /> : null}
      {shown ? null : fallback}
    </div>
  );
}
