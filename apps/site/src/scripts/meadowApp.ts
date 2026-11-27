import { startSunrise } from "./meadow/clock";
import { CYCLE_STOPS, MOON_RANGE, SUNRISE_FROM, SUNRISE_TO } from "./meadow/cycle";
import { createMeadow } from "./meadow/scene";

type MeadowMessage = { state: "ready"; at: number } | { state: "failed" } | { state: "tone"; tone: string; halo: number } | { state: "boom" };

interface MeadowHost {
  postMessage(message: MeadowMessage): void;
}

const host = (window as { webkit?: { messageHandlers?: { meadow?: MeadowHost } } }).webkit?.messageHandlers?.meadow;
const post = (message: MeadowMessage) => host?.postMessage(message);

const NIGHT = CYCLE_STOPS[2];
const DUSK = MOON_RANGE[0];
const flags = location.hash.slice(1).split("-");
const opensAtNight = flags.includes("night");
const creeperCharge = flags.includes("creeper");
const CREEPER_FALLBACK_MS = 2500;
const CREEPER_REDUCED_MS = 1500;
const CREEPER_WATCHDOG_MS = 12000;

let boomed = false;
let boomTimer = 0;
const boom = () => {
  if (boomed) return;
  boomed = true;
  clearTimeout(boomTimer);
  post({ state: "boom" });
};
const boomAfter = (ms: number) => {
  if (!creeperCharge || boomed) return;
  clearTimeout(boomTimer);
  boomTimer = window.setTimeout(boom, ms);
};
const fail = () => {
  post({ state: "failed" });
  boomAfter(CREEPER_FALLBACK_MS);
};

function onceOnScreen(callback: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

function watchFailure(canvas: HTMLCanvasElement) {
  const observer = new MutationObserver(() => {
    if (canvas.dataset.meadow !== "failed") return;
    observer.disconnect();
    fail();
  });
  observer.observe(canvas, { attributes: true, attributeFilter: ["data-meadow"] });
}

function watchTone(title: HTMLElement) {
  let sent = "";
  const send = () => {
    const tone = title.dataset.tone ?? (opensAtNight ? "dark" : "light");
    if (tone === sent) return;
    sent = tone;
    post({ state: "tone", tone, halo: 0 });
  };
  new MutationObserver(send).observe(title, { attributes: true, attributeFilter: ["data-tone"] });
  send();
}

function boot(hero: HTMLElement) {
  const canvas = hero.querySelector<HTMLCanvasElement>("[data-meadow-canvas]");
  if (!canvas || !("WebGL2RenderingContext" in window)) return fail();
  watchFailure(canvas);
  const title = hero.querySelector<HTMLElement>(".hero-title");
  if (title) watchTone(title);
  if (title && opensAtNight) title.dataset.tone = "dark";
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  boomAfter(reducedMotion ? CREEPER_REDUCED_MS : CREEPER_WATCHDOG_MS);
  const meadow = createMeadow({
    canvas,
    hero,
    reducedMotion,
    calm: flags.includes("calm"),
    opening: opensAtNight ? [DUSK, NIGHT] : [SUNRISE_FROM, SUNRISE_TO],
    creeperCharge: creeperCharge && !reducedMotion,
    onCreeperBoom: boom,
    onFirstFrame() {
      onceOnScreen(() => {
        hero.dataset.meadow = "ready";
        startSunrise(hero);
        post({ state: "ready", at: performance.now() });
      });
    },
  });
  if (!meadow) return fail();
  const golden = CYCLE_STOPS[1];
  const between = (share: number) => SUNRISE_TO + (golden - SUNRISE_TO) * share;
  const hours = new Map<string, number>([
    ["dawn", SUNRISE_FROM],
    ["morning", SUNRISE_TO],
    ["midday", between(1 / 3)],
    ["afternoon", between(2 / 3)],
    ["golden", golden],
    ["dusk", DUSK],
    ["night", NIGHT],
  ]);
  Object.assign(window, {
    meadowNight: (night: boolean) => meadow.travelTo(night ? NIGHT : SUNRISE_TO),
    meadowHour: (hour: string, ms?: number) => {
      const cycle = hours.get(hour);
      if (cycle !== undefined) meadow.travelTo(cycle, ms);
    },
  });
}

const hero = document.querySelector<HTMLElement>("[data-meadow]");
if (hero) boot(hero);
else fail();
