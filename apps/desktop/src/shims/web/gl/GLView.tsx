import { useEffect, useRef, type CSSProperties } from "react";
import { observeOnscreen, observePixelSize, subscribeFrames } from "./clock";
import { GLSurface, type Uniforms } from "./surface";
import { frameSubscription, hasSize, measuredSize, stepAnimation, wantsFrames, type ViewClock } from "./viewClock";

type UniformsAt = (css: [number, number], time: number) => Uniforms;

type Props = {
  fragment: string;
  uniformsAt: UniformsAt;
  animation?: { lastFrameTime: number };
  style?: CSSProperties;
  version?: unknown;
};

type ViewState = ViewClock & { surface: GLSurface | null; done: boolean; redraw: () => void };

const fill: CSSProperties = { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", pointerEvents: "none" };

export function GLView({ fragment, uniformsAt, animation, style, version }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(uniformsAt);
  latest.current = uniformsAt;
  const view = useRef<ViewState>({ surface: null, css: [0, 0], time: 0, started: false, pending: 0, done: false, redraw: () => {} });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const v = view.current;
    v.time = 0;
    v.pending = 0;
    v.started = false;
    v.done = false;
    const redraw = () => {
      if (v.surface && hasSize(v.css)) v.surface.draw(latest.current(v.css, v.time));
    };
    v.redraw = redraw;
    const surface = new GLSurface(fragment, redraw);
    v.surface = surface;
    Object.assign(surface.canvas.style, { ...fill, display: "block" });
    el.appendChild(surface.canvas);

    let visible = false;
    let stopOnscreen = () => {};
    const tick = (dt: number) => {
      if (!animation) return;
      const step = stepAnimation(v, dt, animation.lastFrameTime);
      if (step === "unmeasured" || step === "skip") return;
      redraw();
      if (step === "finish") v.done = true;
      syncFrames();
    };
    const frames = frameSubscription(() => subscribeFrames(tick));
    const syncFrames = () => frames.sync(!!animation && wantsFrames(visible, v.css, v.done));

    const { width, height } = el.getBoundingClientRect();
    const initial = measuredSize(width, height, window.devicePixelRatio);
    if (initial) {
      v.css = initial.css;
      surface.resize(initial.pixels[0], initial.pixels[1]);
      if (!animation) redraw();
    }

    const stopSize = observePixelSize(el, (css, pixels) => {
      v.css = css;
      surface.resize(pixels[0], pixels[1]);
      if (!animation || v.started) redraw();
      syncFrames();
    });

    if (animation) {
      stopOnscreen = observeOnscreen(el, (onscreen) => {
        visible = onscreen;
        syncFrames();
      });
    }
    syncFrames();

    return () => {
      stopOnscreen();
      frames.sync(false);
      stopSize();
      surface.canvas.remove();
      surface.dispose();
      v.surface = null;
    };
  }, [fragment, !!animation]);

  useEffect(() => {
    if (!animation) view.current.redraw();
  }, [version]);

  return <div ref={host} style={{ ...fill, ...style }} />;
}
