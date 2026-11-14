import type { MeadowMotion } from "../index";
import { MEADOW_PAGE_API, MEADOW_PAGE_CONFIG_ID, type MeadowPageConfig, type MeadowPageReport, type MeadowPageState } from "./config";

declare const MEADOW_ICON: string;

type Timed = { animation: Animation; origin: number };

type Controls = { muted(next: boolean): void; skip(): void };

const PRESS_KEYS = new Set(["Enter", " "]);
const KEY_CLICK_MS = 500;
const BLOCKED_POINTER = ["pointerdown", "pointermove", "pointerup", "pointerover", "pointerout", "pointerenter", "pointerleave", "touchstart", "touchmove", "touchend", "touchcancel"];
const BLOCKED_DEFAULT = ["contextmenu", "dragstart", "selectstart"];

const states: MeadowPageState[] = [];
let readyAt = 0;
let frames = 0;

function queue(state: MeadowPageState) {
  if (state.state === "tone") {
    const earlier = states.findIndex((queued) => queued.state === "tone");
    if (earlier >= 0) states.splice(earlier, 1);
  }
  states.push(state);
}

function countFrames() {
  frames += 1;
  requestAnimationFrame(countFrames);
}

function readConfig(): MeadowPageConfig | null {
  try {
    return JSON.parse(document.getElementById(MEADOW_PAGE_CONFIG_ID)?.textContent ?? "null") as MeadowPageConfig | null;
  } catch {
    return null;
  }
}

function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className: string, children: (Node | string)[] = []): HTMLElementTagNameMap[Tag] {
  const made = document.createElement(tag);
  made.className = className;
  made.append(...children);
  return made;
}

const rgba = (rgb: readonly number[]) => `rgba(${rgb.join(",")},clamp(0,var(--halo,0),1))`;

function styleFor(config: MeadowPageConfig): string {
  const { intro, ink, handoff } = config;
  const { layout, type, colors, motion } = intro;
  const text = (t: MeadowPageConfig["intro"]["type"]["wordmark"]) => `font-size:${t.fontSize}px;font-weight:${t.fontWeight};letter-spacing:${t.letterSpacing ?? 0}px`;
  return `.hero-title{color:${ink.light.ink};text-shadow:0 0 2px ${rgba(ink.light.halo)};gap:${layout.gap}px}
.hero-title[data-tone=dark]{color:${ink.dark.ink};text-shadow:0 0 2px ${rgba(ink.dark.halo)}}
.hero-title .line>span{line-height:normal}
.hero-title .icon{width:${layout.icon}px;height:${layout.icon}px}
.hero-title .icon img{width:100%;height:100%;display:block}
.hero-title .wordmark{display:flex;${text(type.wordmark)}}
.hero-title .wordmark>span{display:block}
.hero-title .tagline{${text(type.tagline)}}
.meadow-canvas{opacity:0;transition:opacity ${handoff.duration}ms ${handoff.easing}}
.meadow-canvas.shown{opacity:1}
.intro-button{position:fixed;bottom:${layout.inset}px;height:${layout.button}px;min-width:${layout.button}px;box-sizing:border-box;border-radius:${layout.button / 2}px;border:1px solid ${colors.buttonBorder};background:none;color:${colors.buttonText};font-family:-apple-system,system-ui,sans-serif;${text(type.button)};padding:0 ${layout.buttonPad}px;display:flex;align-items:center;justify-content:center;cursor:default;--press:${motion.press.scale};transition:transform ${motion.press.duration}ms ${motion.press.easing}}
.intro-button:hover{background:${colors.buttonHover}}
.intro-button:active,.intro-button.pressed{transform:scale(var(--press))}
.intro-button:focus{outline:none}
.intro-button:focus-visible{outline:2px solid Highlight;outline-offset:2px}
.intro-button.circle{left:${layout.inset}px;width:${layout.button}px;padding:0;--press:${motion.press.circleScale}}
.intro-button.circle svg{width:${intro.mute.iconBox}px;height:${intro.mute.iconBox}px}
.intro-button.skip{right:${layout.inset}px}
.intro-veil{position:fixed;inset:0;background:${colors.background};opacity:0;pointer-events:none}
html,body{user-select:none;-webkit-user-select:none}`;
}

function blockSceneInput() {
  for (const type of BLOCKED_POINTER) window.addEventListener(type, (event) => event.stopImmediatePropagation(), { capture: true });
  for (const type of BLOCKED_DEFAULT) window.addEventListener(type, (event) => event.preventDefault(), { capture: true });
  window.addEventListener("wheel", (event) => event.ctrlKey && event.preventDefault(), { capture: true, passive: false });
}

function start(config: MeadowPageConfig): Controls {
  const { intro } = config;
  const { layout, motion } = intro;
  const style = document.createElement("style");
  style.textContent = styleFor(config);
  document.head.append(style);

  const icon = element("span", "icon");
  const image = document.createElement("img");
  image.src = MEADOW_ICON;
  image.alt = "";
  icon.append(image);
  const letters = [...intro.wordmark].map((letter) => element("span", "", [letter]));
  for (const letter of letters) letter.setAttribute("aria-hidden", "true");
  const wordmark = element("span", "wordmark", letters);
  wordmark.setAttribute("role", "img");
  wordmark.setAttribute("aria-label", intro.wordmark);
  const tagline = element("span", "tagline", [intro.tagline]);
  const title = document.querySelector<HTMLElement>(".hero-title");
  title?.replaceChildren(...[icon, wordmark, tagline].map((part) => element("span", "line", [part])));
  document.querySelector(".meadow-canvas")?.setAttribute("aria-hidden", "true");

  let muted = intro.muted;
  const mute = element("button", "intro-button circle");
  const skip = element("button", "intro-button skip", [intro.skip.label]);
  skip.setAttribute("aria-label", intro.skip.label);
  skip.setAttribute("aria-description", intro.skip.hint);
  const showMuted = () => {
    const label = muted ? intro.mute.unmute : intro.mute.mute;
    mute.setAttribute("aria-label", label);
    mute.title = label;
    mute.innerHTML = muted ? config.muteIcons.muted : config.muteIcons.playing;
  };
  showMuted();
  for (const button of [mute, skip]) button.type = "button";
  const veil = element("div", "intro-veil");
  document.body.append(mute, skip, veil);

  const timed: Timed[] = [];
  const run = (target: Element, keyframes: Keyframe[], m: MeadowMotion, origin: number) => {
    const animation = target.animate(keyframes, { delay: m.delay, duration: m.duration, easing: m.easing, fill: "both" });
    animation.currentTime = Math.max(0, Date.now() - origin);
    timed.push({ animation, origin });
    return animation;
  };
  const resync = () => {
    for (const { animation, origin } of timed) if (animation.playState === "running") animation.currentTime = Math.max(0, Date.now() - origin);
  };
  document.addEventListener("visibilitychange", () => !document.hidden && resync());

  const opacityAt = (p: number) => Math.min(1, p / layout.exitHold);
  const scaleAt = (p: number) => `scale(${1 + (layout.exitScale - 1) * p})`;
  const iconScale = (p: number) => `scale(${layout.iconFrom + (1 - layout.iconFrom) * p})`;
  run(icon, [{ opacity: 0, transform: iconScale(0) }, { opacity: 1, transform: iconScale(layout.iconOpaque), offset: layout.iconOpaque }, { opacity: 1, transform: iconScale(1) }], motion.icon, intro.startedAt);
  letters.forEach((letter, index) => {
    const m = motion.letters[index];
    if (m) run(letter, [{ opacity: 0, transform: `translateY(${layout.letterRise}px)` }, { opacity: 1, transform: "translateY(0)" }], m, intro.startedAt);
  });
  run(tagline, [{ opacity: 0, transform: `translateY(${layout.taglineRise}px)` }, { opacity: 1, transform: "translateY(0)" }], motion.tagline, intro.startedAt);
  const veilFrames = (from: number): Keyframe[] => {
    const held = (layout.exitHold - from) / (1 - from);
    return from < layout.exitHold ? [{ opacity: opacityAt(from) }, { opacity: 1, offset: held }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 1 }];
  };
  let exit = [title ? run(title, [{ transform: scaleAt(0) }, { transform: scaleAt(1) }], motion.exit, intro.startedAt) : null, run(veil, veilFrames(0), motion.exit, intro.startedAt)];

  let skipping = false;
  const skipNow = (asked: boolean) => {
    if (skipping) return;
    skipping = true;
    const progress = Math.max(0, Math.min(1, exit[1]?.effect?.getComputedTiming().progress ?? 0));
    for (const animation of exit) animation?.cancel();
    const now = Date.now();
    const quick = { ...motion.skip, delay: 0 };
    exit = [title ? run(title, [{ transform: scaleAt(progress) }, { transform: scaleAt(1) }], quick, now) : null, run(veil, veilFrames(progress), quick, now)];
    if (asked) queue({ state: "skip" });
  };

  let keyPressAt = 0;
  const pressed = (button: HTMLButtonElement) => {
    if (button === skip) return skipNow(true);
    muted = !muted;
    showMuted();
    queue({ state: "mute", muted });
  };
  for (const button of [mute, skip]) {
    button.addEventListener("click", () => {
      if (Date.now() - keyPressAt < KEY_CLICK_MS) return;
      pressed(button);
    });
  }
  const buttons = [mute, skip];
  window.addEventListener(
    "keydown",
    (event) => {
      const focused = buttons.find((button) => button === document.activeElement);
      if (event.key === "Tab") {
        event.preventDefault();
        const at = focused ? buttons.indexOf(focused) : event.shiftKey ? buttons.length : -1;
        buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
        return;
      }
      if (!focused || !PRESS_KEYS.has(event.key)) return;
      event.preventDefault();
      keyPressAt = Date.now();
      focused.classList.add("pressed");
      pressed(focused);
    },
    { capture: true },
  );
  window.addEventListener(
    "keyup",
    (event) => {
      if (!PRESS_KEYS.has(event.key)) return;
      event.preventDefault();
      keyPressAt = Date.now();
      for (const button of buttons) button.classList.remove("pressed");
    },
    { capture: true },
  );

  return {
    muted(next: boolean) {
      muted = next;
      showMuted();
    },
    skip: () => skipNow(false),
  };
}

function hostMessages(canvas: () => Element | null) {
  const postMessage = (message: MeadowPageState) => {
    if (message.state === "ready" && !readyAt) {
      readyAt = performance.now();
      canvas()?.classList.add("shown");
      requestAnimationFrame(countFrames);
    }
    queue(message);
  };
  Object.defineProperty(window, "webkit", { value: { messageHandlers: { meadow: { postMessage } } } });
}

function take(): MeadowPageReport {
  return { states: states.splice(0), frames, ms: readyAt ? Math.round(performance.now() - readyAt) : 0 };
}

const config = readConfig();
hostMessages(() => document.querySelector(".meadow-canvas"));
blockSceneInput();
const controls: Controls = config ? start(config) : { muted() {}, skip() {} };
if (!config) queue({ state: "failed" });
Object.assign(window, { [MEADOW_PAGE_API]: { take, muted: (next: boolean) => controls.muted(next), skip: () => controls.skip() } });
