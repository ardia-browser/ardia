import type { CSSProperties } from "react";
import { AbsoluteFill, Easing, Img, interpolate, Sequence, staticFile, useCurrentFrame } from "remotion";
import { color, font, loadFonts } from "../../lib/ac-launch/theme";
import { CODE, COMMANDS, FILE_NAME, PROMPT, tokenize, type CodeLine, type Group } from "./code";
import footage from "./footage.json";

loadFonts();

export const FPS = 30;
const TITLE = 3.0;
const SECTION_BEFORE = 11.5;
const SECTION_AFTER = 17.0;
const END = 3.5;
const BEFORE_AT = TITLE;
const AFTER_AT = TITLE + SECTION_BEFORE;
const END_AT = AFTER_AT + SECTION_AFTER;
export const TOTAL_FRAMES = Math.round((END_AT + END) * FPS);

const TYPE_1: [number, number] = [0.6, 2.8];
const SAVE_1 = 3.2;
const TYPE_2: [number, number] = [4.4, 7.4];
const SAVE_2 = 7.9;
const PRE_SAVE = 0.9;
const TERM_IN = 10.0;
const CMD_TYPE: [number, number][] = [
  [10.4, 11.3],
  [13.3, 14.1],
];
const ENTER = [11.5, 14.3];

const WINDOW_SIZE: [number, number] = [1360, 860];
const WIN = { left: 60, top: 190, width: 1250 };
const K = WIN.width / WINDOW_SIZE[0];
const WIN_H = Math.round(WINDOW_SIZE[1] * K);
const PANEL = { left: 1150, top: 222, width: 710, height: 686 };
const GUTTER = 62;
const CODE_SIZE = 16;
const LINE_H = 22;
const TOAST_BOX = { x: 560, y: 745, w: 420, h: 86 };
const TERM = { left: 1150, top: 686, width: 710, height: 236 };
const TERM_SIZE = 19;
const TERM_LINE_H = 30;

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const ease = Easing.out(Easing.cubic);

const editor = {
  bg: "#17140F",
  bar: "#211D18",
  gutter: "#5E574D",
  punct: "#9C9385",
  key: "#F2B880",
  string: "#A9D18E",
  number: "#8DB8F2",
  text: "#EFE8DC",
  added: "rgba(242, 184, 128, 0.08)",
};

const label: CSSProperties = {
  fontFamily: font.mono,
  fontWeight: 460,
  fontStretch: "87.5%",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  fontSize: 20,
  color: color.ink2,
};

type Side = "before" | "after";
type Phase = "default" | "colours" | "look" | "cli1" | "cli2";
type FootageSide = { size: number[]; phases: Record<string, [number, string][]>; toast: number[] | null } | null;

const sides = footage as unknown as Record<Side, FootageSide>;

const seconds = (frame: number) => frame / FPS;

function rise(t: number, at: number, distance = 24): CSSProperties {
  return {
    opacity: interpolate(t, [at, at + 0.5], [0, 1], clamp),
    transform: `translateY(${interpolate(t, [at, at + 0.7], [distance, 0], { ...clamp, easing: ease })}px)`,
  };
}

function frameAt(side: FootageSide, t: number): string | null {
  if (!side) return null;
  const pick = (phase: Phase, since: number) => {
    const list = side.phases[phase] ?? [];
    if (!list.length) return null;
    let best = list[0]!;
    for (const entry of list) if (Math.abs(entry[0] - since) < Math.abs(best[0] - since)) best = entry;
    return best[1];
  };
  if (t < SAVE_1 - PRE_SAVE) {
    const list = side.phases.default ?? [];
    return list.length ? list[Math.min(list.length - 1, Math.floor((t / (SAVE_1 - PRE_SAVE)) * list.length))]![1] : null;
  }
  if (t < SAVE_2 - PRE_SAVE) return pick("colours", t - SAVE_1);
  if (side.phases.cli1?.length && t >= ENTER[1]! - PRE_SAVE) return pick("cli2", t - ENTER[1]!);
  if (side.phases.cli1?.length && t >= ENTER[0]! - PRE_SAVE) return pick("cli1", t - ENTER[0]!);
  return pick("look", t - SAVE_2);
}

function typedChars(group: Group, t: number) {
  const lines = CODE.filter((l) => l.group === group);
  const total = lines.reduce((n, l) => n + l.text.length, 0);
  const span = group === 1 ? TYPE_1 : group === 2 ? TYPE_2 : null;
  if (!span) return Infinity;
  return Math.floor(interpolate(t, span, [0, total], clamp));
}

function lineText(line: CodeLine, t: number, side: Side) {
  if (side === "after" && line.cli && t >= ENTER[line.cli.step - 1]! + 0.1) return line.cli.text;
  return line.text;
}

function cliChanged(line: CodeLine, t: number, side: Side) {
  if (side !== "after" || !line.cli) return false;
  const at = ENTER[line.cli.step - 1]! + 0.1;
  return t >= at && t < at + 1.6;
}

function visibleLines(t: number, side: Side) {
  const budget: Record<Group, number> = { 0: Infinity, 1: typedChars(1, t), 2: typedChars(2, t) };
  const shown: { line: CodeLine; text: string; typing: boolean; index: number }[] = [];
  let cursorLine = 1;
  CODE.forEach((line, index) => {
    const left = budget[line.group];
    if (left <= 0) return;
    const full = lineText(line, t, side);
    const text = full.slice(0, Math.min(full.length, left));
    budget[line.group] = left - full.length;
    const typing = text.length < full.length;
    const comma = line.commaFrom !== undefined && typedChars(line.commaFrom, t) > 0 ? "," : "";
    shown.push({ line, text: typing ? text : text + comma, typing, index });
    if (line.group !== 0) cursorLine = shown.length - 1;
  });
  return { shown, cursorLine };
}

function CodeText({ text }: { text: string }) {
  return (
    <>
      {tokenize(text).map((tok, i) => (
        <span key={i} style={{ color: tok.kind === "space" ? undefined : editor[tok.kind === "punct" ? "punct" : tok.kind] }}>
          {tok.text}
        </span>
      ))}
    </>
  );
}

function CodePanel({ t, side }: { t: number; side: Side }) {
  const { shown, cursorLine } = visibleLines(t, side);
  const terminal = side === "after" && t >= TERM_IN;
  const dirty = (t > TYPE_1[0] && t < SAVE_1) || (t > TYPE_2[0] && t < SAVE_2);
  const typing = (t >= TYPE_1[0] && t <= TYPE_1[1]) || (t >= TYPE_2[0] && t <= TYPE_2[1]);
  const blink = typing || Math.floor(t * 2) % 2 === 0;
  const marked = t > SAVE_2 + 0.25;
  const markIn = interpolate(t, [SAVE_2 + 0.25, SAVE_2 + 0.55], [0, 1], clamp);
  const added = (line: CodeLine) =>
    (line.group === 1 && t > TYPE_1[0] && t < SAVE_1 + 0.6) || (line.group === 2 && t > TYPE_2[0] && t < SAVE_2 + 0.6) || cliChanged(line, t, side);
  return (
    <div
      style={{
        position: "absolute",
        left: PANEL.left,
        top: PANEL.top,
        width: PANEL.width,
        height: PANEL.height,
        borderRadius: 16,
        background: editor.bg,
        boxShadow: "0 30px 70px rgba(22, 19, 15, 0.38), 0 0 0 1px rgba(22, 19, 15, 0.2)",
        overflow: "hidden",
      }}
    >
      <div style={{ height: 46, background: editor.bar, display: "flex", alignItems: "center", padding: "0 20px", gap: 14 }}>
        <div style={{ display: "flex", gap: 8 }}>
          {["#5E574D", "#5E574D", "#5E574D"].map((c, i) => (
            <div key={i} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />
          ))}
        </div>
        <div style={{ fontFamily: font.mono, fontStretch: "87.5%", fontSize: 16, color: editor.text, marginLeft: 10 }}>{FILE_NAME}</div>
        <div style={{ width: 9, height: 9, borderRadius: 5, background: editor.key, opacity: dirty ? 1 : 0 }} />
      </div>
      <div style={{ padding: "22px 0 0 0", fontFamily: font.mono, fontStretch: "75%", fontSize: CODE_SIZE, lineHeight: `${LINE_H}px`, whiteSpace: "pre" }}>
        {shown.map(({ line, text, index }, i) => {
          const isLook = !!line.lookKey;
          return (
            <div key={index} style={{ display: "flex", position: "relative", background: added(line) ? editor.added : "transparent" }}>
              <div style={{ width: GUTTER, textAlign: "right", paddingRight: 18, color: editor.gutter, flexShrink: 0 }}>{i + 1}</div>
              <div style={{ position: "relative", color: editor.text }}>
                <CodeText text={text} />
                {i === cursorLine && blink && !terminal ? <span style={{ display: "inline-block", width: 2, height: 18, background: editor.text, verticalAlign: "-3px", marginLeft: 1 }} /> : null}
                {isLook && marked ? (
                  <div
                    style={{
                      position: "absolute",
                      left: "2ch",
                      width: `${(line.lookKey?.length ?? 0) + 2}ch`,
                      bottom: 1,
                      height: 3,
                      opacity: markIn,
                      background:
                        side === "before"
                          ? `repeating-linear-gradient(135deg, ${color.stamp} 0 3px, transparent 3px 6px)`
                          : "#6F9BF5",
                      borderRadius: 2,
                    }}
                  />
                ) : null}
              </div>
              {isLook && marked ? (
                <div
                  style={{
                    position: "absolute",
                    left: 10,
                    top: 6,
                    width: 11,
                    height: 11,
                    borderRadius: 6,
                    opacity: markIn,
                    background: side === "before" ? color.stamp : "#6F9BF5",
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Keycap({ t, side }: { t: number; side: Side }) {
  const presses: [number, string, number, number][] = [
    [SAVE_1, "⌘S", PANEL.left + PANEL.width - 20, PANEL.top + 60],
    [SAVE_2, "⌘S", PANEL.left + PANEL.width - 20, PANEL.top + 60],
    ...(side === "after" ? ENTER.map((at): [number, string, number, number] => [at, "return", TERM.left + TERM.width - 20, TERM.top + 58]) : []),
  ];
  const press = presses.filter(([at]) => t >= at).pop();
  if (!press || t > press[0] + 0.9) return null;
  const [at, keys, left, top] = press;
  const k = t - at;
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        transform: `translate(-100%, ${interpolate(k, [0, 0.15], [8, 0], { ...clamp, easing: ease })}px)`,
        opacity: interpolate(k, [0, 0.08, 0.7, 0.9], [0, 1, 1, 0], clamp),
        padding: "8px 16px",
        borderRadius: 10,
        background: color.paper,
        color: color.ink,
        fontFamily: font.poster,
        fontWeight: 760,
        fontSize: 26,
        lineHeight: 1,
      }}
    >
      {keys}
    </div>
  );
}

function Terminal({ t }: { t: number }) {
  if (t < TERM_IN) return null;
  const k = t - TERM_IN;
  const rows: { text: string; prompt: boolean; cursor: boolean }[] = [];
  COMMANDS.forEach((step, i) => {
    const [from, to] = CMD_TYPE[i]!;
    const enter = ENTER[i]!;
    const startsAt = i === 0 ? TERM_IN : ENTER[i - 1]! + 0.2;
    if (t < startsAt) return;
    const typed = Math.floor(interpolate(t, [from, to], [0, step.command.length], clamp));
    rows.push({ text: step.command.slice(0, typed), prompt: true, cursor: t < enter });
    if (t >= enter + 0.15) rows.push({ text: step.output, prompt: false, cursor: false });
  });
  const last = ENTER[ENTER.length - 1]!;
  if (t >= last + 0.2) rows.push({ text: "", prompt: true, cursor: true });
  const blink = Math.floor(t * 2) % 2 === 0;
  return (
    <div
      style={{
        position: "absolute",
        left: TERM.left,
        top: TERM.top,
        width: TERM.width,
        height: TERM.height,
        borderRadius: 14,
        background: "#0F0D0A",
        boxShadow: "0 30px 70px rgba(22, 19, 15, 0.5), 0 0 0 1px rgba(239, 232, 220, 0.12)",
        overflow: "hidden",
        opacity: interpolate(k, [0, 0.3], [0, 1], clamp),
        transform: `translateY(${interpolate(k, [0, 0.5], [30, 0], { ...clamp, easing: ease })}px)`,
      }}
    >
      <div style={{ height: 40, background: editor.bar, display: "flex", alignItems: "center", padding: "0 18px", gap: 14 }}>
        <div style={{ display: "flex", gap: 8 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ width: 11, height: 11, borderRadius: 6, background: editor.gutter }} />
          ))}
        </div>
        <div style={{ fontFamily: font.mono, fontStretch: "87.5%", fontSize: 15, color: editor.punct, marginLeft: 8 }}>Terminal</div>
      </div>
      <div style={{ padding: "18px 22px 0", fontFamily: font.mono, fontStretch: "75%", fontSize: TERM_SIZE, lineHeight: `${TERM_LINE_H}px`, whiteSpace: "pre" }}>
        {rows.map((row, i) => (
          <div key={i} style={{ color: row.prompt ? editor.text : editor.string }}>
            {row.prompt ? <span style={{ color: editor.key }}>{PROMPT}</span> : null}
            {row.text}
            {row.cursor && (blink || (row.text.length > 0 && t < ENTER[ENTER.length - 1]!)) ? (
              <span style={{ display: "inline-block", width: 10, height: 20, background: editor.text, verticalAlign: "-4px", marginLeft: 2 }} />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function WindowShot({ t, side }: { t: number; side: Side }) {
  const data = sides[side];
  const file = frameAt(data, t);
  const frameStyle: CSSProperties = {
    position: "absolute",
    left: WIN.left,
    top: WIN.top,
    width: WIN.width,
    height: WIN_H,
    borderRadius: Math.round(21 * K),
    overflow: "hidden",
    boxShadow: "0 30px 70px rgba(22, 19, 15, 0.3), 0 0 0 1px rgba(22, 19, 15, 0.12)",
  };
  const toast = data?.toast;
  const ringOn = side === "before" && toast ? interpolate(t - SAVE_2, [toast[0] + 0.2, toast[0] + 0.4, toast[1] - 0.1, toast[1] + 0.1], [0, 1, 1, 0], clamp) : 0;
  return (
    <>
      {file ? (
        <div style={frameStyle}>
          <Img src={staticFile(file)} style={{ width: WIN.width, height: WIN_H, display: "block" }} />
        </div>
      ) : (
        <div style={{ ...frameStyle, background: color.night2, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18 }}>
          <div style={{ ...label, color: color.nightInk, fontSize: 26 }}>After footage pending</div>
          <div style={{ ...label, color: color.nightInk2, fontSize: 16, textTransform: "none" }}>public/footage/theme-look-16x9/after</div>
        </div>
      )}
      {ringOn > 0 ? (
        <div
          style={{
            position: "absolute",
            left: WIN.left + (TOAST_BOX.x - 10) * K,
            top: WIN.top + (TOAST_BOX.y - 10) * K,
            width: (TOAST_BOX.w + 20) * K,
            height: (TOAST_BOX.h + 20) * K,
            borderRadius: 18,
            boxShadow: `0 0 0 4px ${color.stamp}`,
            opacity: ringOn,
          }}
        />
      ) : null}
    </>
  );
}

const COPY: Record<Side, { pill: string; version: string; headline: string; first: string; second: string; third?: string }> = {
  before: {
    pill: "Before",
    version: "Ardia today",
    headline: "A theme stops at colour",
    first: "Saved: the colours change",
    second: "Saved: type, metrics, layout and icons aren't theme keys",
  },
  after: {
    pill: "After",
    version: "Ardia with theme looks",
    headline: "The same file sets the whole look",
    first: "Saved: the colours change",
    second: "Saved: new font, roomier rows, rounder tiles, back and forward hidden, address field and New Tab moved, icons swapped",
    third: "Or from the terminal: ardia theme set writes one key, and the sidebar restyles live",
  },
};

function Caption({ t, side }: { t: number; side: Side }) {
  const copy = COPY[side];
  const third = !!copy.third && t >= ENTER[0]! + 0.3;
  const second = t >= SAVE_2 + 0.3;
  const at = third ? ENTER[0]! + 0.3 : second ? SAVE_2 + 0.3 : SAVE_1 + 0.3;
  if (t < SAVE_1 + 0.3) return null;
  const tone = second ? (side === "before" ? color.stamp : color.blue) : color.ink;
  return (
    <div
      key={third ? "third" : second ? "second" : "first"}
      style={{
        position: "absolute",
        left: WIN.left,
        top: WIN.top + WIN_H + 22,
        width: 1800,
        fontFamily: font.serif,
        fontSize: 30,
        lineHeight: 1.25,
        color: tone,
        ...rise(t, at, 12),
      }}
    >
      {third ? copy.third : second ? copy.second : copy.first}
    </div>
  );
}

function SectionShot({ side }: { side: Side }) {
  const t = seconds(useCurrentFrame());
  const copy = COPY[side];
  const after = side === "after";
  const length = after ? SECTION_AFTER : SECTION_BEFORE;
  const fade = interpolate(t, [0, 0.3, length - 0.35, length], [0, 1, 1, 0], clamp);
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <div style={{ position: "absolute", left: 60, top: 46, display: "flex", alignItems: "center", gap: 16, ...rise(t, 0.05, 10) }}>
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
          {copy.pill}
        </div>
        <div style={{ ...label, fontSize: 18 }}>{copy.version}</div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 60,
          top: 92,
          fontFamily: font.poster,
          fontWeight: 850,
          fontStretch: "75%",
          textTransform: "uppercase",
          letterSpacing: "0.02em",
          fontSize: 72,
          lineHeight: 1,
          color: color.ink,
          ...rise(t, 0.12, 16),
        }}
      >
        {copy.headline}
      </div>
      <WindowShot t={t} side={side} />
      <CodePanel t={t} side={side} />
      {after ? <Terminal t={t} /> : null}
      <Keycap t={t} side={side} />
      <Caption t={t} side={side} />
    </AbsoluteFill>
  );
}

function TitleCard() {
  const t = seconds(useCurrentFrame());
  const out = interpolate(t, [TITLE - 0.35, TITLE], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ justifyContent: "center", paddingLeft: 140, opacity: out }}>
      <div style={{ ...label, fontSize: 26, color: color.blue, ...rise(t, 0.1) }}>Ardia · theme files</div>
      <div
        style={{
          marginTop: 22,
          fontFamily: font.poster,
          fontWeight: 860,
          fontStretch: "75%",
          textTransform: "uppercase",
          fontSize: 150,
          lineHeight: 0.92,
          color: color.ink,
          ...rise(t, 0.3),
        }}
      >
        One file.
        <br />
        The whole look.
      </div>
      <div style={{ marginTop: 30, fontFamily: font.serif, fontSize: 38, color: color.ink2, ...rise(t, 0.6) }}>
        The same edit to <span style={{ fontFamily: font.mono, fontSize: 32, fontStretch: "87.5%" }}>{FILE_NAME}</span>, before and after.
      </div>
      <Img src={staticFile("brand/app-icon.png")} style={{ position: "absolute", right: 170, top: 300, width: 480, height: 480, ...rise(t, 0.4) }} />
    </AbsoluteFill>
  );
}

function EndCard() {
  const t = seconds(useCurrentFrame());
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: interpolate(t, [0, 0.6], [0, 1], clamp) }}>
      <Img src={staticFile("brand/app-icon.png")} style={{ width: 190, height: 190, ...rise(t, 0.1) }} />
      <div
        style={{
          marginTop: 34,
          maxWidth: 1500,
          textAlign: "center",
          fontFamily: font.poster,
          fontWeight: 820,
          fontStretch: "80%",
          fontSize: 76,
          lineHeight: 1.02,
          color: color.ink,
          ...rise(t, 0.25),
        }}
      >
        Fonts, sizes, layout and icons
        <br />
        from one theme file or one command, live
      </div>
      <div style={{ ...label, marginTop: 30, fontSize: 24, color: color.blue, ...rise(t, 0.5) }}>ardia.dev</div>
    </AbsoluteFill>
  );
}

export function ThemeLookFilm() {
  return (
    <AbsoluteFill style={{ background: color.paper }}>
      <Sequence durationInFrames={Math.round(TITLE * FPS)}>
        <TitleCard />
      </Sequence>
      <Sequence from={Math.round(BEFORE_AT * FPS)} durationInFrames={Math.round(SECTION_BEFORE * FPS)}>
        <SectionShot side="before" />
      </Sequence>
      <Sequence from={Math.round(AFTER_AT * FPS)} durationInFrames={Math.round(SECTION_AFTER * FPS)}>
        <SectionShot side="after" />
      </Sequence>
      <Sequence from={Math.round(END_AT * FPS)} durationInFrames={Math.round(END * FPS)}>
        <EndCard />
      </Sequence>
    </AbsoluteFill>
  );
}
