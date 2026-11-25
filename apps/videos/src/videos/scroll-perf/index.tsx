import type { CSSProperties } from "react";
import { AbsoluteFill, Easing, Img, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import { color, font, loadFonts } from "../../lib/ac-launch/theme";
import { clamp, label } from "../../lib/fixes-film/look";
import data from "./timeline.json";

loadFonts();

interface Numbers {
  uniqueFps: number | null;
  longestMs: number | null;
  hitches: number | null;
  takes?: number;
  range?: { uniqueFps: [number, number]; longestMs: [number, number] };
}
interface Clip {
  file: string;
  take: string;
  w: number;
  h: number;
  scale: number;
  inS: number;
  outS: number;
  gestures: { from: number; to: number; name: string }[];
  flags: string;
  numbers: Numbers;
}
interface Side {
  label: string;
  scenes: Record<string, Clip>;
}
interface Timeline {
  kind: "pan" | "trackpad";
  before: Side;
  after: Side | null;
}

const T = data as unknown as Timeline;
const FPS = 60;
const INTRO = Math.round(4.2 * FPS);
const CARD = Math.round(1.6 * FPS);
const HOLD = Math.round(0.5 * FPS);
const OUTRO = Math.round(6 * FPS);
const REPLAY_RATE = 0.25;
const REPLAY_SOURCE = 1.4;
const TICKS = 120;
const LEFT = 60;
const RIGHT = 980;
const STAND_IN = T.kind === "pan";

interface SceneInfo {
  id: string;
  title: string;
  body: string;
  layout: "stack" | "side";
  cam: [number, number, number, number];
  blocked?: string;
}

const SCENES: SceneInfo[] = [
  {
    id: "scrollperf-strip",
    title: "Top tab strip, 60 tabs",
    body: "Tabs on top, one profile. Two-finger pans right and left across the strip, twice, the same events on both sides.",
    layout: "stack",
    cam: [0, 0, 1280, 150],
  },
  {
    id: "scrollperf-sidebar",
    title: "Sidebar, 200 tabs",
    body: "A flick down the sidebar and back up, twice. The list should follow every frame.",
    layout: "side",
    cam: [0, 0, 330, 800],
  },
];

const sceneOf = (side: Side | null, id: string) => side?.scenes[id] ?? null;
const lengthOf = (clip: Clip | null) => (clip ? Math.round((clip.outS - clip.inS) * FPS) : Math.round(4 * FPS));
const replayOf = (clip: Clip | null) => (clip ? Math.round((REPLAY_SOURCE / REPLAY_RATE) * FPS) : 0);

const plans = SCENES.map((s) => {
  const clip = sceneOf(T.before, s.id) ?? sceneOf(T.after, s.id);
  const play = s.blocked ? Math.round(4.5 * FPS) : lengthOf(clip);
  const replay = s.blocked ? 0 : replayOf(clip);
  return { scene: s, play, replay, length: CARD + play + HOLD + replay + HOLD };
});
const starts = plans.map((_, i) => INTRO + plans.slice(0, i).reduce((a, p) => a + p.length, 0));
const TOTAL = INTRO + plans.reduce((a, p) => a + p.length, 0) + OUTRO;

export const meta = { width: 1920, height: 1080, fps: FPS, durationInFrames: TOTAL };

type Place = { left: number; top: number; w: number; h: number };

function placesFor(s: SceneInfo): { panels: [Place, Place]; meters: [Place, Place] } {
  const [, , cw, ch] = s.cam;
  if (s.layout === "stack") {
    const w = 1800;
    const h = Math.round((ch * w) / cw);
    const top = 300;
    const gap = 150;
    const meter = (y: number): Place => ({ left: LEFT, top: y + h + 16, w, h: 100 });
    return {
      panels: [
        { left: LEFT, top, w, h },
        { left: LEFT, top: top + h + gap + 40, w, h },
      ],
      meters: [meter(top), meter(top + h + gap + 40)],
    };
  }
  const h = 740;
  const w = Math.round((cw * h) / ch);
  const top = 280;
  const panel = (x: number): Place => ({ left: x, top, w, h });
  const meter = (x: number): Place => ({ left: x + w + 30, top, w: 880 - w - 30, h });
  return { panels: [panel(LEFT), panel(RIGHT)], meters: [meter(LEFT), meter(RIGHT)] };
}

const panelStyle = (p: Place): CSSProperties => ({
  position: "absolute",
  left: p.left,
  top: p.top,
  width: p.w,
  height: p.h,
  overflow: "hidden",
  borderRadius: 16,
  background: color.night2,
  boxShadow: "0 30px 70px rgba(22,19,15,0.16), 0 0 0 1px rgba(22,19,15,0.10)",
});

function SideLabel({ after, text, place }: { after: boolean; text: string; place: Place }) {
  return (
    <div style={{ position: "absolute", left: place.left, top: place.top - 46, display: "flex", alignItems: "center", gap: 14 }}>
      <div
        style={{
          ...label,
          fontSize: 19,
          fontWeight: 620,
          color: after ? color.paper : color.ink,
          background: after ? color.blue : "transparent",
          boxShadow: after ? "none" : `inset 0 0 0 2px ${color.ink}`,
          padding: "6px 12px 5px",
          borderRadius: 8,
        }}
      >
        {after ? "After" : "Before"}
      </div>
      <div style={{ ...label, fontSize: 18 }}>{text}</div>
    </div>
  );
}

function Footage({ clip, s, place, from, rate }: { clip: Clip; s: SceneInfo; place: Place; from: number; rate: number }) {
  const [cx, cy, cw] = s.cam;
  const k = place.w / cw;
  const style: CSSProperties = { position: "absolute", left: -cx * k, top: -cy * k, width: (clip.w / clip.scale) * k, height: (clip.h / clip.scale) * k, maxWidth: "none" };
  return <OffthreadVideo src={staticFile(clip.file)} trimBefore={Math.round(from * FPS)} muted playbackRate={rate} style={style} />;
}

const spansOf = (clip: Clip) =>
  clip.gestures.map((g) => {
    const lo = Math.max(0, Math.round((g.from - clip.inS) * FPS));
    const hi = Math.min(clip.flags.length - 1, Math.round((g.to + 0.15 - clip.inS) * FPS));
    let first = -1;
    let last = -1;
    for (let i = lo; i <= hi; i++) {
      if (clip.flags[i] !== "1") continue;
      if (first < 0) first = i;
      last = i;
    }
    return [first, last] as const;
  });

function Ticks({ clip, t, place }: { clip: Clip; t: number; place: Place }) {
  const idx = Math.round((t - clip.inS) * FPS);
  const flags = clip.flags;
  const spans = spansOf(clip);
  const inGesture = (i: number) => spans.some(([a, b]) => a >= 0 && i >= a && i <= b);
  const runOf = (i: number) => {
    if (flags[i] !== "0") return 0;
    let a = i;
    let b = i;
    while (a > 0 && flags[a - 1] === "0") a--;
    while (b < flags.length - 1 && flags[b + 1] === "0") b++;
    return b - a + 1;
  };
  const w = place.w / TICKS;
  const bars = [];
  for (let j = 0; j < TICKS; j++) {
    const i = idx - TICKS + 1 + j;
    if (i < 0 || i >= flags.length) continue;
    const active = inGesture(i);
    const isNew = flags[i] === "1";
    const hitch = active && !isNew && runOf(i) > 2;
    bars.push(
      <div
        key={j}
        style={{
          position: "absolute",
          left: j * w + 1,
          bottom: 0,
          width: Math.max(1, w - 2),
          height: isNew ? 34 : 10,
          borderRadius: 2,
          background: hitch ? color.stamp : isNew ? (active ? color.ink : color.ink2) : active ? "rgba(22,19,15,0.28)" : "rgba(22,19,15,0.12)",
        }}
      />,
    );
  }
  return <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 34 }}>{bars}</div>;
}

function Stat({ value, unit, name, tone }: { value: string; unit: string; name: string; tone: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontFamily: font.poster, fontWeight: 820, fontStretch: "80%", fontSize: 54, lineHeight: 1, color: tone }}>
        {value}
        <span style={{ fontSize: 26, fontWeight: 650, marginLeft: 6, color: color.ink2 }}>{unit}</span>
      </div>
      <div style={{ ...label, fontSize: 15 }}>{name}</div>
    </div>
  );
}

const fmt = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? "–" : v.toFixed(digits));

function Meter({ clip, t, place, stacked }: { clip: Clip | null; t: number; place: Place; stacked: boolean }) {
  const n = clip?.numbers;
  const stats = (
    <>
      <Stat value={fmt(n?.uniqueFps)} unit="fps" name="new frames per second" tone={color.ink} />
      <Stat value={fmt(n?.longestMs)} unit="ms" name="longest frame on screen" tone={color.ink} />
      <Stat value={fmt(n?.hitches)} unit="" name="hitches (3+ repeated frames)" tone={n?.hitches ? color.stamp : color.ink} />
    </>
  );
  const takes = n?.takes ? `median of ${n.takes} takes · fps ${fmt(n.range?.uniqueFps[0])}–${fmt(n.range?.uniqueFps[1])}` : "";
  if (stacked) {
    return (
      <div style={{ position: "absolute", left: place.left, top: place.top, width: place.w, height: place.h }}>
        <div style={{ display: "flex", gap: 64, alignItems: "flex-start" }}>
          {stats}
          <div style={{ ...label, fontSize: 14, marginLeft: "auto", alignSelf: "flex-end" }}>{takes}</div>
        </div>
        <div style={{ position: "absolute", left: 640, right: 0, top: 0, height: 34 }}>{clip ? <Ticks clip={clip} t={t} place={{ ...place, w: place.w - 640 }} /> : null}</div>
      </div>
    );
  }
  return (
    <div style={{ position: "absolute", left: place.left, top: place.top, width: place.w, height: place.h, display: "flex", flexDirection: "column", gap: 30 }}>
      {stats}
      <div style={{ ...label, fontSize: 14 }}>{takes}</div>
      <div style={{ position: "relative", height: 34, marginTop: "auto" }}>{clip ? <Ticks clip={clip} t={t} place={{ ...place }} /> : null}</div>
      <div style={{ ...label, fontSize: 13 }}>last 2 s · tall = new frame · red = hitch</div>
    </div>
  );
}

function Pending({ place }: { place: Place }) {
  return (
    <div style={{ ...panelStyle(place), background: color.paperDeep, display: "flex", alignItems: "center", justifyContent: "center", padding: 40, boxSizing: "border-box" }}>
      <div style={{ fontFamily: font.serif, fontSize: 30, lineHeight: 1.3, color: color.ink2, textAlign: "center" }}>
        After: filmed once the scroll and swipe fixes land, with the same session and the same gestures.
      </div>
    </div>
  );
}

function Side_({ clip, s, place, meter, after, text, from, rate, play }: { clip: Clip | null; s: SceneInfo; place: Place; meter: Place; after: boolean; text: string; from: number; rate: number; play: number }) {
  const frame = useCurrentFrame();
  const t = clip ? from + (Math.min(frame, play) / FPS) * rate : 0;
  return (
    <>
      <SideLabel after={after} text={text} place={place} />
      {clip ? (
        <div style={panelStyle(place)}>
          <Footage clip={clip} s={s} place={place} from={from} rate={rate} />
        </div>
      ) : (
        <Pending place={place} />
      )}
      <Meter clip={clip} t={t} place={meter} stacked={s.layout === "stack"} />
    </>
  );
}

function Header({ s, index, mode }: { s: SceneInfo; index: number; mode: string }) {
  return (
    <>
      <div style={{ position: "absolute", left: LEFT, top: 40, right: 60, display: "flex", justifyContent: "space-between" }}>
        <div style={{ ...label, color: color.ink }}>Scroll smoothness · before and after</div>
        <div style={{ ...label, color: color.blue }}>
          {mode} · {String(index + 1).padStart(2, "0")} / {String(SCENES.length).padStart(2, "0")}
        </div>
      </div>
      <div style={{ position: "absolute", left: LEFT, top: 84, width: 860, fontFamily: font.poster, fontWeight: 850, fontStretch: "75%", textTransform: "uppercase", letterSpacing: "0.02em", fontSize: 54, lineHeight: 0.98, color: color.ink }}>
        {s.title}
      </div>
      <div style={{ position: "absolute", left: RIGHT, top: 84, width: 880, fontFamily: font.serif, fontSize: 26, lineHeight: 1.3, color: color.ink }}>
        {s.body}
        {STAND_IN ? <span style={{ color: color.stamp }}> Stand-in input: precise pans without trackpad phases (the screen was locked).</span> : null}
      </div>
    </>
  );
}

function Shot({ s, index, play, mode, replay }: { s: SceneInfo; index: number; play: number; mode: string; replay: boolean }) {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, 14, play + HOLD - 10, play + HOLD], [0, 1, 1, 0], clamp);
  const { panels, meters } = placesFor(s);
  const b = sceneOf(T.before, s.id);
  const a = sceneOf(T.after, s.id);
  const fromOf = (clip: Clip | null) => (clip ? (replay ? clip.gestures[0]!.from - 0.1 : clip.inS) : 0);
  const rate = replay ? REPLAY_RATE : 1;
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <Header s={s} index={index} mode={replay ? "Quarter speed · first gesture" : mode} />
      <Side_ clip={b} s={s} place={panels[0]} meter={meters[0]} after={false} text={T.before.label} from={fromOf(b)} rate={rate} play={play} />
      <Side_ clip={a} s={s} place={panels[1]} meter={meters[1]} after text={T.after?.label ?? "pending"} from={fromOf(a)} rate={rate} play={play} />
    </AbsoluteFill>
  );
}

function Blocked({ s, index }: { s: SceneInfo; index: number }) {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, 14], [0, 1], clamp);
  const { panels } = placesFor(s);
  const b = sceneOf(T.before, s.id);
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <Header s={s} index={index} mode="Needs an unlocked screen" />
      <SideLabel after={false} text={T.before.label} place={panels[0]} />
      <div style={panelStyle(panels[0])}>{b ? <Footage clip={b} s={s} place={panels[0]} from={b.inS} rate={1} /> : null}</div>
      <div style={{ position: "absolute", left: 480, top: 300, width: 1300, fontFamily: font.serif, fontSize: 34, lineHeight: 1.32, color: color.ink }}>{s.blocked}</div>
    </AbsoluteFill>
  );
}

function Card({ s, index }: { s: SceneInfo; index: number }) {
  const frame = useCurrentFrame();
  const rise = (delay: number) => ({
    opacity: interpolate(frame, [delay, delay + 20], [0, 1], clamp),
    transform: `translateY(${interpolate(frame, [delay, delay + 28], [20, 0], { ...clamp, easing: Easing.out(Easing.cubic) })}px)`,
  });
  const out = interpolate(frame, [CARD - 16, CARD], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ justifyContent: "center", paddingLeft: 140, opacity: out }}>
      <div style={{ ...label, fontSize: 24, color: color.blue, ...rise(0) }}>
        Gesture {String(index + 1).padStart(2, "0")} / {String(SCENES.length).padStart(2, "0")}
      </div>
      <div style={{ marginTop: 26, maxWidth: 1500, fontFamily: font.poster, fontWeight: 850, fontStretch: "75%", textTransform: "uppercase", fontSize: 104, lineHeight: 0.95, color: color.ink, ...rise(6) }}>{s.title}</div>
    </AbsoluteFill>
  );
}

function Intro() {
  const frame = useCurrentFrame();
  const rise = (delay: number) => ({
    opacity: interpolate(frame, [delay, delay + 32], [0, 1], clamp),
    transform: `translateY(${interpolate(frame, [delay, delay + 44], [28, 0], { ...clamp, easing: Easing.out(Easing.cubic) })}px)`,
  });
  const out = interpolate(frame, [INTRO - 20, INTRO], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ justifyContent: "center", paddingLeft: 140, paddingRight: 700, opacity: out }}>
      <div style={{ ...label, fontSize: 26, color: color.blue, ...rise(4) }}>Before and after · 60 fps, frame for frame</div>
      <div style={{ marginTop: 20, fontFamily: font.poster, fontWeight: 860, fontStretch: "75%", fontSize: 170, lineHeight: 0.9, color: color.ink, ...rise(12) }}>Scroll</div>
      <div style={{ marginTop: 26, fontFamily: font.serif, fontSize: 34, lineHeight: 1.3, color: color.ink2, ...rise(26) }}>
        The same session and the same scroll events on {T.before.label} and {T.after ? T.after.label : "the fixed build (pending)"}. Every frame the app drew is in the film: a repeated frame is a stall.
      </div>
      {STAND_IN ? (
        <div style={{ marginTop: 22, fontFamily: font.serif, fontSize: 26, lineHeight: 1.3, color: color.stamp, ...rise(34) }}>
          Draft: filmed with the screen locked, so the input is precise scrolling without trackpad phases, momentum or rubber band.
        </div>
      ) : null}
      <Img src={staticFile("brand/app-icon.png")} style={{ position: "absolute", right: 170, top: 300, width: 420, height: 420, ...rise(20) }} />
    </AbsoluteFill>
  );
}

function Outro() {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 24], [0, 1], clamp);
  const cell: CSSProperties = { fontFamily: font.poster, fontWeight: 760, fontStretch: "85%", fontSize: 40, color: color.ink, padding: "14px 24px", textAlign: "right" };
  const head: CSSProperties = { ...label, fontSize: 17, padding: "10px 24px", textAlign: "right" };
  const row = (s: SceneInfo) => {
    const b = sceneOf(T.before, s.id)?.numbers;
    const a = sceneOf(T.after, s.id)?.numbers;
    const blocked = !!s.blocked;
    return (
      <tr key={s.id} style={{ borderTop: `1px solid ${color.rule}` }}>
        <td style={{ ...cell, textAlign: "left", fontSize: 32 }}>{s.title}</td>
        <td style={cell}>{blocked ? "–" : `${fmt(b?.uniqueFps)} fps`}</td>
        <td style={cell}>{blocked ? "–" : `${fmt(b?.longestMs)} ms`}</td>
        <td style={cell}>{blocked ? "–" : fmt(b?.hitches)}</td>
        <td style={{ ...cell, color: color.blue }}>{blocked || !a ? "–" : `${fmt(a.uniqueFps)} fps`}</td>
        <td style={{ ...cell, color: color.blue }}>{blocked || !a ? "–" : `${fmt(a.longestMs)} ms`}</td>
        <td style={{ ...cell, color: color.blue }}>{blocked || !a ? "–" : fmt(a.hitches)}</td>
      </tr>
    );
  };
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity }}>
      <div style={{ ...label, fontSize: 22, color: color.ink, marginBottom: 24 }}>During the gesture · median take</div>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...head, textAlign: "left" }} />
            <th style={head} colSpan={3}>
              Before · {T.before.label}
            </th>
            <th style={{ ...head, color: color.blue }} colSpan={3}>
              After · {T.after?.label ?? "pending"}
            </th>
          </tr>
          <tr>
            <th style={head} />
            <th style={head}>new frames</th>
            <th style={head}>longest</th>
            <th style={head}>hitches</th>
            <th style={head}>new frames</th>
            <th style={head}>longest</th>
            <th style={head}>hitches</th>
          </tr>
        </thead>
        <tbody>{SCENES.map(row)}</tbody>
      </table>
    </AbsoluteFill>
  );
}

export default function Video() {
  return (
    <AbsoluteFill style={{ background: color.paper }}>
      <Sequence durationInFrames={INTRO}>
        <Intro />
      </Sequence>
      {plans.map((p, i) => (
        <Sequence key={p.scene.id} from={starts[i]} durationInFrames={p.length}>
          <Sequence durationInFrames={CARD}>
            <Card s={p.scene} index={i} />
          </Sequence>
          {p.scene.blocked ? (
            <Sequence from={CARD} durationInFrames={p.length - CARD}>
              <Blocked s={p.scene} index={i} />
            </Sequence>
          ) : (
            <>
              <Sequence from={CARD} durationInFrames={p.play + HOLD}>
                <Shot s={p.scene} index={i} play={p.play} mode="Real time" replay={false} />
              </Sequence>
              <Sequence from={CARD + p.play + HOLD} durationInFrames={p.replay + HOLD}>
                <Shot s={p.scene} index={i} play={p.replay} mode="Quarter speed" replay />
              </Sequence>
            </>
          )}
        </Sequence>
      ))}
      <Sequence from={TOTAL - OUTRO}>
        <Outro />
      </Sequence>
    </AbsoluteFill>
  );
}
