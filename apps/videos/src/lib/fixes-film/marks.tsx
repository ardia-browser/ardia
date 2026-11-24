import { Easing, interpolate } from "remotion";
import { color, font } from "../ac-launch/theme";
import { clamp } from "./look";
import type { Callout, Cam, Event, Highlight } from "./types";

const TONE = { good: "#2FA36B", bad: "#E5484D", plain: color.paper };
const RIPPLE = { life: 0.55, from: 10, to: 64, hold: 26 };

export function CalloutPill({ callouts, t, width, height }: { callouts: Callout[]; t: number; width: number; height: number }) {
  const live = callouts.filter((c) => t >= c.t && (c.until === undefined || t < c.until + 0.2));
  const c = live[live.length - 1];
  if (!c) return null;
  const k = t - c.t;
  const fadeOut = c.until === undefined ? 1 : interpolate(t, [c.until, c.until + 0.2], [1, 0], clamp);
  const opacity = interpolate(k, [0, 0.12], [0, 1], clamp) * fadeOut;
  const lift = interpolate(k, [0, 0.22], [14, 0], { ...clamp, easing: Easing.out(Easing.cubic) });
  const tone = TONE[c.tone ?? "plain"];
  const size = Math.round(Math.min(40, Math.max(28, width / 24)));
  return (
    <div
      style={{
        position: "absolute",
        left: width / 2,
        top: c.place === "top" ? 30 + lift : height - 34 + lift,
        transform: c.place === "top" ? "translate(-50%, 0)" : "translate(-50%, -100%)",
        opacity,
        display: "flex",
        alignItems: "center",
        gap: size * 0.45,
        padding: `${size * 0.36}px ${size * 0.62}px`,
        borderRadius: size * 0.5,
        background: "rgba(22,19,15,0.92)",
        boxShadow: `0 12px 30px rgba(0,0,0,0.28), inset 0 0 0 3px ${tone}`,
        color: color.paper,
        fontFamily: font.poster,
        fontWeight: 720,
        fontSize: size,
        lineHeight: 1.05,
        whiteSpace: "nowrap",
      }}
    >
      <div style={{ width: size * 0.42, height: size * 0.42, borderRadius: "50%", background: tone, flex: "none" }} />
      {c.text}
    </div>
  );
}

export function EdgeGlow({ highlights, t, cam, k }: { highlights: Highlight[]; t: number; cam: Cam; k: number }) {
  return (
    <>
      {highlights.map((h) => {
        const opacity = interpolate(t, [h.t - 0.05, h.t + 0.08, h.until, h.until + 0.25], [0, 1, 1, 0], clamp);
        if (opacity <= 0) return null;
        return (
          <div
            key={`${h.t}`}
            style={{
              position: "absolute",
              left: (h.x - cam[0]) * k,
              top: (h.y - cam[1]) * k,
              width: h.w * k,
              height: h.h * k,
              opacity,
              background: "rgba(255,196,0,0.55)",
              boxShadow: `0 0 ${18 * k}px ${8 * k}px rgba(255,196,0,0.45)`,
              borderRadius: 4 * k,
            }}
          />
        );
      })}
    </>
  );
}

export function ClickRipples({ events, t, cam, k }: { events: Event[]; t: number; cam: Cam; k: number }) {
  const rings: { x: number; y: number; age: number; at: number }[] = [];
  let x: number | null = null;
  let y: number | null = null;
  let held: number | null = null;
  for (const e of events) {
    if (e.t > t) break;
    if (e.x !== undefined && e.y !== undefined) {
      x = e.x;
      y = e.y;
    }
    if (e.down) held = e.t;
    if (e.up) held = null;
    if (e.down && x !== null && y !== null && t - e.t < RIPPLE.life) rings.push({ x, y, age: t - e.t, at: e.t });
  }
  const hold = held !== null && x !== null && y !== null && t - held > 0.18 ? { x, y, grow: interpolate(t - held, [0.18, 0.32], [0, 1], clamp) } : null;
  return (
    <>
      {hold ? (
        <div
          style={{
            position: "absolute",
            left: (hold.x - cam[0]) * k - RIPPLE.hold,
            top: (hold.y - cam[1]) * k - RIPPLE.hold,
            width: RIPPLE.hold * 2,
            height: RIPPLE.hold * 2,
            borderRadius: "50%",
            background: "rgba(40,110,240,0.28)",
            border: `4px solid ${color.blue}`,
            boxSizing: "border-box",
            opacity: hold.grow,
            transform: `scale(${0.6 + 0.4 * hold.grow})`,
          }}
        />
      ) : null}
      {rings.map((r) => {
        const u = r.age / RIPPLE.life;
        const radius = interpolate(u, [0, 1], [RIPPLE.from, RIPPLE.to], { ...clamp, easing: Easing.out(Easing.cubic) });
        return (
          <div
            key={`${r.at}`}
            style={{
              position: "absolute",
              left: (r.x - cam[0]) * k - radius,
              top: (r.y - cam[1]) * k - radius,
              width: radius * 2,
              height: radius * 2,
              borderRadius: "50%",
              border: `5px solid ${color.blue}`,
              background: "rgba(40,110,240,0.16)",
              opacity: 1 - u,
              boxSizing: "border-box",
            }}
          />
        );
      })}
    </>
  );
}
