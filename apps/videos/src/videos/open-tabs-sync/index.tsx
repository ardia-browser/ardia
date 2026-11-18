import type { CSSProperties } from "react";
import { AbsoluteFill, Easing, Img, interpolate, Sequence, staticFile, useCurrentFrame } from "remotion";
import { color, font, loadFonts } from "../../lib/ac-launch/theme";
import data from "./timeline.json";

loadFonts();

type Frame = [number, string | null, string | null, string | null, string[]];
type PageShot = [number, string, string];
interface Ev {
  t: number;
  win?: string;
  x?: number;
  y?: number;
  down?: number;
  up?: number;
  hide?: number;
  key?: string;
}
interface Track {
  frames: Frame[];
  pages: PageShot[];
  events: Ev[];
}
interface Timeline {
  window: { w: number; h: number };
  settingsWindow: { w: number; h: number };
  sidebar: number;
  row0: number;
  row: number;
  marks: Record<string, number>;
  A: Track;
  B: Track;
}

const T = data as unknown as Timeline;
const M = T.marks;
const FPS = 30;
const INTRO = Math.round(3.4 * FPS);
const OUTRO = Math.round(3.2 * FPS);
const FADE = 7;
const PANEL_W = 900;
const PANEL_TOP = 384;
const PANEL_H = PANEL_W * (T.window.h / T.window.w);
const FULL: Cam = [0, 0, T.window.w];
const SIDE: Cam = [0, 0, 720];
const LEFTS = { A: 40, B: 980 } as const;
const NAMES = { A: "MacBook Air", B: "iMac" } as const;
const PAGE = { x: T.sidebar - 1, y: 49, w: T.window.w - T.sidebar - 9, h: T.window.h - 59, r: 8 };
const CURSOR_PX_PER_PT = 2.72;
const CURSOR_TIP = { x: 18, y: 16 };
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const label: CSSProperties = {
  fontFamily: font.mono,
  fontWeight: 460,
  fontStretch: "87.5%",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  fontSize: 20,
  color: color.ink2,
};

function lastAt<X>(list: X[], t: number, time: (x: X) => number): X | null {
  let lo = 0;
  let hi = list.length - 1;
  let found: X | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (time(list[mid]!) <= t) {
      found = list[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

type Cam = [number, number, number];

const firstEventAfter = (track: Track, after: number, test: (e: Ev) => boolean = () => true) => track.events.find((e) => e.t > after && test(e))?.t ?? after;

interface Shot {
  from: number;
  to: number;
  rate: number;
  caption: string;
  sub: string;
  cams: { A: Cam; B: Cam };
}

const keyAt = (name: string) => T.A.events.find((e) => e.key === name)?.t ?? M.closedA! - 1;

const SHOTS: Shot[] = [
  {
    from: firstEventAfter(T.A, M.start!) - 0.4,
    to: M.toggle! + 1.2,
    rate: 1,
    caption: "Turn on All Open Tabs",
    sub: "Settings › Sync, on the MacBook Air. One switch per profile.",
    cams: { A: FULL, B: FULL },
  },
  {
    from: M.settingsClosed! - 0.1,
    to: M.merged! + 1.7,
    rate: 1,
    caption: "Both Macs now share their tabs",
    sub: "Each Mac's open tab shows up on the other.",
    cams: { A: SIDE, B: SIDE },
  },
  {
    from: M.openStart! - 0.1,
    to: M.opened!,
    rate: 2.5,
    caption: "Open tabs on the MacBook Air",
    sub: "Watch the iMac's sidebar.",
    cams: { A: FULL, B: SIDE },
  },
  {
    from: M.opened!,
    to: M.arrived! + 2.3,
    rate: 1,
    caption: "They land on the iMac",
    sub: "Unloaded, in the background. The tab you're on stays put.",
    cams: { A: SIDE, B: SIDE },
  },
  {
    from: firstEventAfter(T.B, M.arrived!) - 0.3,
    to: M.goneA! + 1.8,
    rate: 1,
    caption: "Close one on the iMac",
    sub: "It closes on the MacBook Air too.",
    cams: { A: SIDE, B: SIDE },
  },
  {
    from: keyAt("⇧⌘W") - 1.0,
    to: M.end!,
    rate: 1,
    caption: "Close the MacBook Air's window",
    sub: "Nothing is lost: the iMac keeps every tab.",
    cams: { A: FULL, B: SIDE },
  },
];

const plays = SHOTS.map((s) => Math.round(((s.to - s.from) / s.rate) * FPS));
const starts = plays.map((_, i) => INTRO + plays.slice(0, i).reduce((a, b) => a + b, 0));
const TOTAL = INTRO + plays.reduce((a, b) => a + b, 0) + OUTRO;

export const meta = { width: 1920, height: 1080, fps: FPS, durationInFrames: TOTAL };

function pointerAt(events: Ev[], t: number) {
  let at: Ev | null = null;
  let pressed = false;
  for (const e of events) {
    if (e.t > t) break;
    if (e.hide) at = null;
    else if (e.x !== undefined && e.y !== undefined) at = e;
    if (e.down) pressed = true;
    if (e.up) pressed = false;
  }
  return at ? { win: at.win ?? "main", x: at.x ?? 0, y: at.y ?? 0, pressed } : null;
}

function shownAfter(track: Track, t: number) {
  const before = lastAt(track.frames, t - 0.001, (x) => x[0])?.[1];
  return track.frames.find((x) => x[0] >= t && x[1] !== null && x[1] !== before)?.[0] ?? t;
}

function arrivals(track: Track, windows: [number, number][]) {
  const seen = new Map<string, number>();
  const first = new Map<string, number>();
  for (const f of track.frames) {
    for (const id of f[4]) {
      const bare = id.replace(/\*$/, "");
      if (!seen.has(bare)) {
        seen.set(bare, f[0]);
        if (id.endsWith("*") && windows.some(([a, b]) => f[0] >= a && f[0] <= b)) first.set(bare, shownAfter(track, f[0]));
      }
    }
  }
  return first;
}

function departures(track: Track, after: number) {
  const gone = new Map<string, { at: number; index: number }>();
  for (let i = 1; i < track.frames.length; i++) {
    const [t, main, , , tabs] = track.frames[i]!;
    const prev = track.frames[i - 1]![4];
    if (t < after || main === null || !tabs.length) continue;
    prev.forEach((id, index) => {
      const bare = id.replace(/\*$/, "");
      if (!gone.has(bare) && !tabs.some((x) => x.replace(/\*$/, "") === bare)) gone.set(bare, { at: shownAfter(track, t), index });
    });
  }
  return gone;
}

const DEPARTURES = { A: departures(T.A, M.closeB! - 0.5), B: new Map<string, { at: number; index: number }>() };

const ARRIVALS = {
  A: arrivals(T.A, [[M.mergeStart! - 0.5, M.merged! + 1]]),
  B: arrivals(T.B, [[0.5, M.end!]]),
};

function Panel({ name, t, cam }: { name: "A" | "B"; t: number; cam: Cam }) {
  const track = T[name];
  const K = PANEL_W / cam[2];
  const ox = -cam[0] * K;
  const oy = -cam[1] * K;
  const full = { w: T.window.w * K, h: T.window.h * K };
  const f = lastAt(track.frames, t, (x) => x[0]);
  const windowless = !!f && f[1] === null && f[4].length === 0;
  const main = f?.[1] ?? (windowless ? null : lastAt(track.frames.filter((x) => x[1] !== null), t, (x) => x[0])?.[1] ?? null);
  const url = f?.[3] ?? null;
  const page = url ? lastAt(track.pages.filter((p) => p[1] === url), t, (p) => p[0]) : null;
  const settings = f?.[2] ?? null;
  const p = pointerAt(track.events, t);
  const settingsBox = { x: ox + ((T.window.w - T.settingsWindow.w) / 2) * K, y: oy + ((T.window.h - T.settingsWindow.h) / 2) * K, w: T.settingsWindow.w * K, h: T.settingsWindow.h * K };
  const cursorScale = K / CURSOR_PX_PER_PT;
  const cursorX = p ? (p.win === "settings" ? settingsBox.x : ox) + p.x * K : 0;
  const cursorY = p ? (p.win === "settings" ? settingsBox.y : oy) + p.y * K : 0;
  const keys = track.events.filter((e) => e.key && t >= e.t && t < e.t + 1.3);
  const keyEv = keys[keys.length - 1];
  const left = LEFTS[name];
  const rings = [...ARRIVALS[name].entries()].filter(([, at]) => t >= at && t < at + 2.2);
  const leaving = [...DEPARTURES[name].entries()].filter(([, d]) => t >= d.at - 0.9 && t < d.at + 0.12);
  return (
    <>
      <div style={{ position: "absolute", left, top: PANEL_TOP - 58, display: "flex", alignItems: "baseline", gap: 16 }}>
        <div style={{ fontFamily: font.poster, fontWeight: 780, fontStretch: "87.5%", fontSize: 34, color: color.ink }}>{NAMES[name]}</div>
      </div>
      {keyEv ? (
        <div
          style={{
            position: "absolute",
            left: left + PANEL_W,
            top: PANEL_TOP - 14 + interpolate(t - keyEv.t, [0, 0.18], [8, 0], { ...clamp, easing: Easing.out(Easing.cubic) }),
            transform: "translate(-100%, -100%)",
            opacity: interpolate(t - keyEv.t, [0, 0.12, 1.1, 1.3], [0, 1, 1, 0], clamp),
            padding: "8px 16px",
            borderRadius: 10,
            background: color.ink,
            color: color.paper,
            fontFamily: font.poster,
            fontWeight: 760,
            fontSize: 26,
            lineHeight: 1,
          }}
        >
          {keyEv.key === "Return" ? "Return ↩" : keyEv.key}
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          left,
          top: PANEL_TOP,
          width: PANEL_W,
          height: PANEL_H,
          overflow: "hidden",
          borderRadius: 16,
          background: "linear-gradient(160deg, #3A2F35 0%, #2A2328 100%)",
          boxShadow: "0 30px 70px rgba(22,19,15,0.18), 0 0 0 1px rgba(22,19,15,0.12)",
        }}
      >
        {main ? <Img src={staticFile(`footage/open-tabs-sync/${main}`)} style={{ position: "absolute", left: ox, top: oy, width: full.w, height: full.h, maxWidth: "none" }} /> : null}
        {main && page ? (
          <Img
            src={staticFile(`footage/open-tabs-sync/${page[2]}`)}
            style={{
              position: "absolute",
              left: ox + PAGE.x * K,
              top: oy + PAGE.y * K,
              maxWidth: "none",
              width: PAGE.w * K,
              height: PAGE.h * K,
              borderBottomLeftRadius: PAGE.r * K,
              borderBottomRightRadius: PAGE.r * K,
            }}
          />
        ) : null}
        {main && f
          ? rings.map(([id, at]) => {
              const index = f[4].findIndex((x) => x.replace(/\*$/, "") === id);
              if (index < 0) return null;
              const k = t - at;
              const opacity = interpolate(k, [0, 0.15, 1.6, 2.2], [0, 1, 1, 0], clamp);
              return (
                <div
                  key={id}
                  style={{
                    position: "absolute",
                    left: ox + 8 * K,
                    top: oy + (T.row0 + T.row * index - 17) * K,
                    width: (T.sidebar - 16) * K,
                    height: 34 * K,
                    borderRadius: 9 * K,
                    boxShadow: `0 0 0 ${2.5}px #6EA8FF, 0 0 18px 2px rgba(110,168,255,0.55)`,
                    opacity,
                  }}
                />
              );
            })
          : null}
        {main
          ? leaving.map(([id, d]) => {
              const opacity = interpolate(t, [d.at - 0.9, d.at - 0.75, d.at - 0.05, d.at + 0.12], [0, 1, 1, 0], clamp);
              return (
                <div
                  key={id}
                  style={{
                    position: "absolute",
                    left: ox + 8 * K,
                    top: oy + (T.row0 + T.row * d.index - 17) * K,
                    width: (T.sidebar - 16) * K,
                    height: 34 * K,
                    borderRadius: 9 * K,
                    boxShadow: "0 0 0 2.5px #FF8A6B, 0 0 18px 2px rgba(255,138,107,0.5)",
                    opacity,
                  }}
                />
              );
            })
          : null}
        {settings ? (
          <>
            <div style={{ position: "absolute", inset: 0, background: "rgba(10,8,9,0.35)" }} />
            <Img
              src={staticFile(`footage/open-tabs-sync/${settings}`)}
              style={{
                position: "absolute",
                left: settingsBox.x,
                top: settingsBox.y,
                width: settingsBox.w,
                height: settingsBox.h,
                borderRadius: 10,
                boxShadow: "0 24px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.12)",
              }}
            />
          </>
        ) : null}
        {windowless ? (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ ...label, color: "rgba(239,232,220,0.62)", fontSize: 22 }}>No Ardia windows open</div>
          </div>
        ) : null}
        {p && main ? (
          <Img
            src={staticFile("brand/cursor-arrow.png")}
            style={{
              position: "absolute",
              left: cursorX - CURSOR_TIP.x * cursorScale,
              top: cursorY - CURSOR_TIP.y * cursorScale,
              width: 112 * cursorScale,
              height: 160 * cursorScale,
              transform: `scale(${p.pressed ? 0.86 : 1})`,
              transformOrigin: `${CURSOR_TIP.x / 1.12}% ${CURSOR_TIP.y / 1.6}%`,
            }}
          />
        ) : null}
      </div>
    </>
  );
}

function ShotView({ shot, play }: { shot: Shot; play: number }) {
  const frame = useCurrentFrame();
  const t = shot.from + (frame / FPS) * shot.rate;
  const fade = interpolate(frame, [0, FADE, play - FADE, play], [0, 1, 1, 0], clamp);
  const rise = interpolate(frame, [0, 14], [16, 0], { ...clamp, easing: Easing.out(Easing.cubic) });
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <div style={{ position: "absolute", left: 40, top: 92, right: 40, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ transform: `translateY(${rise}px)` }}>
          <div style={{ fontFamily: font.poster, fontWeight: 850, fontStretch: "75%", textTransform: "uppercase", letterSpacing: "0.01em", fontSize: 76, lineHeight: 0.95, color: color.ink }}>
            {shot.caption}
          </div>
          <div style={{ marginTop: 14, fontFamily: font.serif, fontSize: 34, lineHeight: 1.25, color: color.ink2 }}>{shot.sub}</div>
        </div>
        <div style={{ ...label, color: color.blue, paddingTop: 10, whiteSpace: "nowrap" }}>{shot.rate === 1 ? "All Open Tabs" : `${shot.rate}× speed`}</div>
      </div>
      <Panel name="A" t={t} cam={shot.cams.A} />
      <Panel name="B" t={t} cam={shot.cams.B} />
    </AbsoluteFill>
  );
}

function Intro() {
  const frame = useCurrentFrame();
  const rise = (delay: number) => ({
    opacity: interpolate(frame, [delay, delay + 18], [0, 1], clamp),
    transform: `translateY(${interpolate(frame, [delay, delay + 24], [22, 0], { ...clamp, easing: Easing.out(Easing.cubic) })}px)`,
  });
  const out = interpolate(frame, [INTRO - 12, INTRO], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ justifyContent: "center", paddingLeft: 150, paddingRight: 150, opacity: out }}>
      <div style={{ ...label, fontSize: 24, color: color.blue, ...rise(2) }}>A question on X</div>
      <div style={{ marginTop: 26, fontFamily: font.serif, fontStyle: "italic", fontSize: 92, lineHeight: 1.1, color: color.ink, maxWidth: 1500, ...rise(8) }}>
        “Any chance of unpinned tabs also syncing between computers?”
      </div>
      <div style={{ marginTop: 40, fontFamily: font.poster, fontWeight: 800, fontStretch: "87.5%", fontSize: 54, color: color.stamp, ...rise(40) }}>Now there is.</div>
    </AbsoluteFill>
  );
}

function Outro() {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 16], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity }}>
      <Img src={staticFile("brand/app-icon.png")} style={{ width: 170, height: 170 }} />
      <div style={{ marginTop: 34, fontFamily: font.poster, fontWeight: 820, fontStretch: "87.5%", fontSize: 72, color: color.ink }}>Settings › Sync › All Open Tabs</div>
      <div style={{ marginTop: 18, fontFamily: font.serif, fontSize: 34, color: color.ink2 }}>Also in Settings › Profiles.</div>
      <div style={{ ...label, marginTop: 26, fontSize: 24, color: color.blue }}>ardia.dev</div>
    </AbsoluteFill>
  );
}

function Video() {
  return (
    <AbsoluteFill style={{ background: color.paper }}>
      <Sequence durationInFrames={INTRO}>
        <Intro />
      </Sequence>
      {SHOTS.map((shot, i) => (
        <Sequence key={shot.caption} from={starts[i]} durationInFrames={plays[i]}>
          <ShotView shot={shot} play={plays[i]!} />
        </Sequence>
      ))}
      <Sequence from={TOTAL - OUTRO}>
        <Outro />
      </Sequence>
    </AbsoluteFill>
  );
}

export default Video;
