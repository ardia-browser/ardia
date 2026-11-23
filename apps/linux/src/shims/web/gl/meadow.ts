import POSTERS from "../../../../../../packages/shaders/ios/Meadow/posters.json" with { type: "json" };

export type MeadowTone = { tone: "light" | "dark"; halo: number };
export type MeadowPoster = { state: string; file: string; aspect: number; horizon: number };
export type MeadowScene = { setNight(night: boolean): void; dispose(): void };

type Scene = { dispose(): void; travelTo(cycle: number): void };
type Site = { night: number; dusk: number; sunriseFrom: number; sunriseTo: number; createMeadow: typeof import("@ardia-site/meadow/scene").createMeadow; startSunrise(hero: HTMLElement): void; resetSunrise(): void };

const HANDOFF_MS = 400;
const HANDOFF_EASE = "cubic-bezier(0.37, 0, 0.63, 1)";

export const MEADOW_POSTER_URLS: Record<string, string> = {
  "dawn-wider-2400.webp": new URL("../../../../../../packages/shaders/ios/Meadow/dawn-wider-2400.webp", import.meta.url).href,
  "dawn-wide-1920.webp": new URL("../../../../../../packages/shaders/ios/Meadow/dawn-wide-1920.webp", import.meta.url).href,
  "dawn-laptop-1920.webp": new URL("../../../../../../packages/shaders/ios/Meadow/dawn-laptop-1920.webp", import.meta.url).href,
  "dawn-mid-1600.webp": new URL("../../../../../../packages/shaders/ios/Meadow/dawn-mid-1600.webp", import.meta.url).href,
  "morning-wider-2208.webp": new URL("../../../../../../packages/shaders/ios/Meadow/morning-wider-2208.webp", import.meta.url).href,
  "morning-wide-1766.webp": new URL("../../../../../../packages/shaders/ios/Meadow/morning-wide-1766.webp", import.meta.url).href,
  "morning-laptop-1625.webp": new URL("../../../../../../packages/shaders/ios/Meadow/morning-laptop-1625.webp", import.meta.url).href,
  "morning-mid-1354.webp": new URL("../../../../../../packages/shaders/ios/Meadow/morning-mid-1354.webp", import.meta.url).href,
};

export const MEADOW_POSTERS: MeadowPoster[] = POSTERS;

export function nearestMeadowPoster(aspect: number, reduceMotion: boolean): MeadowPoster | null {
  const state = reduceMotion ? "morning" : "dawn";
  let best: MeadowPoster | null = null;
  for (const poster of MEADOW_POSTERS) {
    if (poster.state !== state) continue;
    if (!best || Math.abs(Math.log(poster.aspect / aspect)) < Math.abs(Math.log(best.aspect / aspect))) best = poster;
  }
  return best;
}

export function meadowToneOf(tone: string | undefined, halo: string, night: boolean): MeadowTone {
  const resolved = tone === "dark" || tone === "light" ? tone : night ? "dark" : "light";
  const amount = Number.parseFloat(halo);
  return { tone: resolved, halo: Number.isFinite(amount) ? amount : 0 };
}

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;

export const isSoftwareRenderer = (renderer: string) => SOFTWARE_RENDERER.test(renderer);

let hardware: boolean | undefined;

function rendersInHardware() {
  if (hardware !== undefined) return hardware;
  hardware = false;
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (gl) {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      hardware = !info || !isSoftwareRenderer(String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)));
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    hardware = false;
  }
  return hardware;
}

const fill = { position: "absolute", left: "0", top: "0", width: "100%", height: "100%" } as const;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, style: Partial<CSSStyleDeclaration>, children: Node[] = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  Object.assign(node.style, style);
  node.append(...children);
  return node;
}

function heroTitle() {
  const line = (inner: HTMLElement) => element("span", "line", { display: "block" }, [inner]);
  const icon = element("span", "icon", { display: "block", width: "96px", height: "96px" });
  const wordmark = element("span", "wordmark", { display: "block", fontSize: "64px", fontWeight: "200", letterSpacing: "-1.5px" }, [document.createTextNode("Ardia")]);
  const tagline = element("span", "tagline", { display: "block", fontSize: "17px", fontWeight: "300" }, [document.createTextNode("Your new home on the internet")]);
  return element(
    "div",
    "hero-title",
    { display: "flex", flexDirection: "column", alignItems: "center", gap: "18px", margin: "0", color: "transparent", fontFamily: "-apple-system, system-ui, sans-serif", fontWeight: "normal" },
    [line(icon), line(wordmark), line(tagline)],
  );
}

async function loadSite(): Promise<Site> {
  const [{ createMeadow }, { startSunrise, resetSunrise }, cycle] = await Promise.all([
    import("@ardia-site/meadow/scene"),
    import("@ardia-site/meadow/clock"),
    import("@ardia-site/meadow/cycle"),
  ]);
  return { createMeadow, startSunrise, resetSunrise, night: cycle.CYCLE_STOPS[2] ?? cycle.SUNRISE_TO, dusk: cycle.MOON_RANGE[0], sunriseFrom: cycle.SUNRISE_FROM, sunriseTo: cycle.SUNRISE_TO };
}

export function mountMeadow(
  container: HTMLElement,
  { night, reduceMotion, onTone }: { night: boolean; reduceMotion: boolean; onTone: (tone: MeadowTone) => void },
): MeadowScene {
  let wantNight = night;
  let pageNight = night;
  let scene: Scene | null = null;
  let site: Site | null = null;
  let ready = false;
  let disposed = false;
  let handoff = 0;
  const observers: MutationObserver[] = [];

  const poster = element("div", "", { ...fill, backgroundSize: "cover", backgroundPosition: "50% 65%", backgroundRepeat: "no-repeat" });
  const canvas = element("canvas", "meadow-canvas", { ...fill, display: "block" });
  const title = heroTitle();
  const text = element("div", "hero-text", { ...fill, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }, [title]);
  const hero = element("div", "hero", { ...fill, overflow: "hidden", opacity: "0", transition: `opacity ${HANDOFF_MS}ms ${HANDOFF_EASE}` }, [canvas, text]);
  hero.setAttribute("data-meadow", "");
  hero.setAttribute("aria-hidden", "true");
  container.append(poster, hero);

  const placePoster = () => {
    if (ready || wantNight) {
      poster.style.backgroundImage = "";
      return;
    }
    const { width, height } = container.getBoundingClientRect();
    const choice = width > 0 && height > 0 ? nearestMeadowPoster(width / height, reduceMotion) : null;
    const url = choice ? MEADOW_POSTER_URLS[choice.file] : undefined;
    poster.style.backgroundImage = url ? `url("${url}")` : "";
    poster.style.backgroundPosition = `50% ${Math.round((choice?.horizon ?? 0.65) * 100)}%`;
  };
  placePoster();

  let sentTone = "";
  const sendTone = () => {
    const tone = meadowToneOf(title.dataset.tone, title.style.getPropertyValue("--halo"), pageNight);
    const key = `${tone.tone}:${tone.halo}`;
    if (key === sentTone) return;
    sentTone = key;
    onTone(tone);
  };
  if (pageNight) title.dataset.tone = "dark";
  const toneWatch = new MutationObserver(sendTone);
  toneWatch.observe(title, { attributes: true, attributeFilter: ["data-tone", "style"] });
  observers.push(toneWatch);
  sendTone();

  const sendNight = () => {
    if (!ready || !scene || !site || pageNight === wantNight) return;
    pageNight = wantNight;
    scene.travelTo(wantNight ? site.night : site.sunriseTo);
  };

  const markReady = () => {
    if (disposed || ready) return;
    ready = true;
    hero.dataset.meadow = "ready";
    site?.startSunrise(hero);
    hero.style.opacity = "1";
    handoff = window.setTimeout(() => {
      handoff = 0;
      placePoster();
    }, HANDOFF_MS);
    sendNight();
  };

  const start = async () => {
    if (!("WebGL2RenderingContext" in window) || !rendersInHardware()) return;
    const loaded = await loadSite();
    if (disposed) return;
    site = loaded;
    const failure = new MutationObserver(() => {
      if (canvas.dataset.meadow === "failed") hero.style.opacity = "0";
    });
    failure.observe(canvas, { attributes: true, attributeFilter: ["data-meadow"] });
    observers.push(failure);
    loaded.resetSunrise();
    pageNight = wantNight;
    scene = loaded.createMeadow({
      canvas,
      hero,
      hint: null,
      reducedMotion: reduceMotion,
      opening: pageNight ? [loaded.dusk, loaded.night] : [loaded.sunriseFrom, loaded.sunriseTo],
      onFirstFrame: () => requestAnimationFrame(() => requestAnimationFrame(markReady)),
    });
  };
  start().catch((error) => reportError(error));

  return {
    setNight(next) {
      if (next === wantNight) return;
      wantNight = next;
      if (!ready) placePoster();
      sendNight();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(handoff);
      for (const observer of observers) observer.disconnect();
      scene?.dispose();
      scene = null;
      canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
      poster.remove();
      hero.remove();
    },
  };
}
