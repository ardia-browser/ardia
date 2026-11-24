import { startSunrise } from "./clock";
import { createMeadow } from "./scene";

function onceOnScreen(callback: () => void) {
  requestAnimationFrame(callback);
}

function boot(hero: HTMLElement) {
  const canvas = hero.querySelector<HTMLCanvasElement>("[data-meadow-canvas]");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fallback = () => hero.dispatchEvent(new Event("meadow:failed"));
  if (!canvas || !("WebGL2RenderingContext" in window)) {
    fallback();
    return;
  }

  const safety = window.setTimeout(fallback, 1400);
  try {
    const meadow = createMeadow({
      canvas,
      hero,
      reducedMotion,
      onFirstFrame() {
        clearTimeout(safety);
        onceOnScreen(() => {
          hero.dataset.meadow = "ready";
          startSunrise(hero);
        });
      },
    });
    if (!meadow) {
      clearTimeout(safety);
      fallback();
    }
  } catch {
    clearTimeout(safety);
    fallback();
  }
}

const hero = document.querySelector<HTMLElement>("[data-meadow]");
if (hero) boot(hero);
