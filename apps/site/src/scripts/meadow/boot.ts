import { startSunrise } from "./clock";
import { createMeadow } from "./scene";

function onceOnScreen(callback: () => void) {
  requestAnimationFrame(callback);
}

function hydratePosterFallback(hero: HTMLElement) {
  const picture = hero.querySelector<HTMLPictureElement>(".hero-poster[data-js-poster]");
  const image = picture?.querySelector<HTMLImageElement>("img");
  if (!picture || !image || !image.dataset.fallbackSrc) return;
  const template = hero.querySelector<HTMLTemplateElement>("template[data-poster-sources]");
  if (template) {
    picture.prepend(template.content.cloneNode(true));
    template.remove();
  }
  if (image.dataset.fallbackSizes) image.sizes = image.dataset.fallbackSizes;
  if (image.dataset.fallbackSrcset) image.srcset = image.dataset.fallbackSrcset;
  image.src = image.dataset.fallbackSrc;
  delete image.dataset.fallbackSrc;
  delete image.dataset.fallbackSrcset;
  delete image.dataset.fallbackSizes;
}

function boot(hero: HTMLElement) {
  const canvas = hero.querySelector<HTMLCanvasElement>("[data-meadow-canvas]");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fallback = () => {
    if (hero.dataset.meadow === "ready") return;
    hydratePosterFallback(hero);
    hero.dataset.meadow = "failed";
  };
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
