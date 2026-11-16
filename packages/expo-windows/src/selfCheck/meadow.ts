import type { MeadowIntro, MeadowIntroEvent, MeadowTone } from "@ardia/shaders";
import type { AppNative, WindowsNative } from "@ardia/shell";
import { engineAvailable, hostCall } from "../engine/host";
import { meadowPageUrl } from "../meadow/pageUrl";
import { startMeadowSession } from "../meadow/session";
import { requireNativeModule } from "../modules";
import { expectEqual, expectTrue, type Check } from "./check";

const PROBE_KEY = "self-check-webgl-probe";
const PROBE_URL = "data:text/html,<title>webgl probe</title>";
const VISIBILITY_CODE = `let frames = 0; const tick = () => { frames += 1; requestAnimationFrame(tick); }; requestAnimationFrame(tick); setTimeout(() => post("result", JSON.stringify({ hidden: document.hidden, state: document.visibilityState, frames })), 500);`;
const WARP_READY_LIMIT_MS = 20000;
const PROBE_CODE = `const canvas = document.createElement("canvas"); const gl = canvas.getContext("webgl2"); let renderer = ""; if (gl) { const info = gl.getExtension("WEBGL_debug_renderer_info"); renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)); } post("result", JSON.stringify({ webgl2: !!gl, renderer }));`;
const PROBE_TRIES = 40;
const PROBE_WAIT_MS = 250;
const INTRO_KEY = "self-check-meadow-intro";
const INTRO_PROFILE = `${INTRO_KEY}@`;
const INTRO_PLACE = { unit: "px", x: 0, y: 0, width: 640, height: 400 };
const LIVE_MS = 25000;
const TONE_MS = 3000;
const ANSWER_MS = 2000;
const CLOSED_MS = 4000;
const MOTION = { delay: 0, duration: 300, easing: "linear" };
const FAR_OFF_MS = 600000;

type Probe = { webgl2: boolean; renderer: string };

const launchTest = () => requireNativeModule<Pick<AppNative, "launchConfig">>("ArdiaApp").launchConfig().test;
const windows = () => requireNativeModule<Pick<WindowsNative, "windowIds">>("ArdiaAppWindows");
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const webglRequired = () => launchTest().meadowWebGL === "required";

async function firstWindow() {
  const ids = await windows().windowIds();
  expectTrue(ids.length > 0, "no window is open to host a page");
  return ids[0]!;
}

async function probe(windowId: string): Promise<Probe | null> {
  for (let tries = 0; tries < PROBE_TRIES; tries++) {
    const reply = await hostCall<{ result?: unknown }>("tab.call", { key: PROBE_KEY, method: "evaluate", code: PROBE_CODE }, windowId).catch(() => null);
    if (typeof reply?.result === "string") return JSON.parse(reply.result) as Probe;
    await pause(PROBE_WAIT_MS);
  }
  return null;
}

async function until(what: string, ms: number, met: () => boolean) {
  const end = Date.now() + ms;
  while (!met()) {
    expectTrue(Date.now() < end, `${what} within ${ms} ms`);
    await pause(50);
  }
}

function checkIntro(startedAt: number): MeadowIntro {
  const text = { fontSize: 17, fontWeight: "300" };
  return {
    startedAt,
    muted: false,
    wordmark: "Check",
    tagline: "self check",
    skip: { label: "Skip check", hint: "skips the check" },
    mute: { mute: "Mute check", unmute: "Unmute check", mutedIcon: "speaker.slash.fill", playingIcon: "speaker.wave.3.fill", iconSize: 13, iconWeight: "medium", iconBox: 20 },
    colors: { background: "#F4EFE6", buttonBorder: "#00000022", buttonText: "#16130F", buttonHover: "#0000000D" },
    type: { wordmark: { fontSize: 64, fontWeight: "200", letterSpacing: -1.5 }, tagline: text, button: { fontSize: 13, fontWeight: "500" } },
    layout: { gap: 24, icon: 96, inset: 28, button: 32, buttonPad: 14, iconFrom: 0.6, iconOpaque: 0.4, letterRise: 14, taglineRise: 6, exitScale: 1.08, exitHold: 0.6 },
    motion: {
      icon: MOTION,
      letters: [...Array(5)].map(() => MOTION),
      tagline: MOTION,
      exit: { ...MOTION, delay: FAR_OFF_MS },
      skip: MOTION,
      holds: { exit: 200, skip: 200 },
      press: { scale: 0.96, circleScale: 0.9, duration: 120, easing: "linear" },
    },
  };
}

const click = (selector: string) => `document.querySelector(${JSON.stringify(selector)})?.click(); post("result", "clicked");`;

export const checks: Check[] = [
  {
    name: "meadow: an engine page reports whether it has WebGL2, and on which renderer",
    async run() {
      if (!engineAvailable()) {
        expectTrue(!webglRequired(), "the WebGL2 run needs the engine, and it isn't available");
        return;
      }
      const windowId = await firstWindow();
      await hostCall("tab.create", { key: PROBE_KEY, url: PROBE_URL, profile: "" }, windowId);
      try {
        const found = await probe(windowId);
        console.info(`[ardia windows] webgl2 probe: ${found ? `webgl2 ${found.webgl2 ? "available" : "unavailable"}, renderer "${found.renderer}"` : "no answer"}`);
        await hostCall("tab.show", { key: PROBE_KEY, visible: true, ...INTRO_PLACE }, windowId).catch(() => undefined);
        const seen = await hostCall<{ result?: unknown }>("tab.call", { key: PROBE_KEY, method: "evaluate", code: VISIBILITY_CODE }, windowId).catch(() => null);
        console.info(`[ardia windows] webgl2 probe, shown page: ${String(seen?.result ?? "no answer")}`);
        if (webglRequired()) expectTrue(found?.webgl2, `no WebGL2 in an engine page (${JSON.stringify(found)})`);
      } finally {
        await hostCall("tab.close", { key: PROBE_KEY }).catch(() => undefined);
      }
    },
  },
  {
    name: "meadow: with WebGL2 the intro's page draws its first frame, sends its tone, round-trips Skip and Mute and is closed",
    async run() {
      if (!webglRequired()) return;
      expectTrue(engineAvailable(), "the WebGL2 run needs the engine, and it isn't available");
      const windowId = await firstWindow();
      const intro = checkIntro(Date.now());
      const url = meadowPageUrl(intro, false, INTRO_PLACE.width / INTRO_PLACE.height);
      const told: MeadowIntroEvent[] = [];
      const tones: MeadowTone[] = [];
      const call = (method: string, extra: Record<string, unknown>) => hostCall<{ result?: unknown }>("tab.call", { key: INTRO_KEY, method, ...extra }, windowId);
      await hostCall("tab.create", { key: INTRO_KEY, url, profile: INTRO_PROFILE }, windowId);
      let closed = false;
      const session = startMeadowSession(intro, false, url, {
        now: () => Date.now(),
        later(ms, run) {
          const timer = setTimeout(run, ms);
          return () => clearTimeout(timer);
        },
        every(ms, run) {
          const timer = setInterval(run, ms);
          return () => clearInterval(timer);
        },
        evaluate: (code) => call("evaluate", { code }).then((reply) => reply?.result ?? null, () => null),
        run: (code) => void call("executeJavaScript", { code }).catch(() => undefined),
        show: () => void hostCall("tab.show", { key: INTRO_KEY, visible: true, ...INTRO_PLACE }, windowId).catch(() => undefined),
        async close() {
          await hostCall("tab.close", { key: INTRO_KEY }).catch(() => undefined);
          closed = true;
        },
        tell: (event) => told.push(event),
        tone: (tone) => tones.push(tone),
        log: (line) => console.info(line),
      }, WARP_READY_LIMIT_MS);
      try {
        await until("the page drew its first frame or fell back", LIVE_MS, () => told.some((event) => event.kind === "live" || event.kind === "fallback"));
        const live = told.find((event) => event.kind === "live");
        expectTrue(live, `the page fell back: ${JSON.stringify(told)}`);
        console.info(`[ardia windows] meadow self-check: first frame after ${live.firstFrameMs} ms`);
        await until("the page sent its tone", TONE_MS, () => tones.length > 0);
        expectTrue(tones[0]!.tone === "light" || tones[0]!.tone === "dark", `the tone was ${JSON.stringify(tones[0])}`);
        await call("evaluate", { code: click(".intro-button.circle") });
        await until("Mute in the page reached the app", ANSWER_MS, () => told.some((event) => event.kind === "mute"));
        expectEqual(told.find((event) => event.kind === "mute"), { kind: "mute", muted: true }, "the page's mute");
        session.setMuted(false);
        let label: unknown = null;
        for (const end = Date.now() + ANSWER_MS; label !== intro.mute.mute && Date.now() < end; await pause(100)) {
          label = (await call("evaluate", { code: `post("result", document.querySelector(".intro-button.circle")?.getAttribute("aria-label") ?? "")` }))?.result;
        }
        expectEqual(label, intro.mute.mute, "the mute button's label after the app unmuted");
        await call("evaluate", { code: click(".intro-button.skip") });
        await until("Skip in the page reached the app", ANSWER_MS, () => told.some((event) => event.kind === "skip"));
        await until("the page was closed after Skip", CLOSED_MS, () => closed && told.some((event) => event.kind === "closed"));
        const listed = await hostCall<{ tabs: { key: string }[] }>("tabs.list");
        expectTrue(!listed.tabs.some((tab) => tab.key === INTRO_KEY), "the intro's page is still listed after it closed");
      } finally {
        session.end();
        if (!closed) await hostCall("tab.close", { key: INTRO_KEY }).catch(() => undefined);
        await hostCall("profile.release", { profile: INTRO_PROFILE }).catch(() => undefined);
      }
    },
  },
];
