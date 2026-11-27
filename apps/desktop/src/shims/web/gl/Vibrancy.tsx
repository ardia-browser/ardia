import type { CSSProperties } from "react";
import { displayP3 } from "./colors";
import { vibrancyStops } from "./material";
import { FILM_GRAIN_SIDE, filmGrainAlpha, filmGrainOpacity, filmGrainSize } from "./themeSwatch";

const fill: CSSProperties = { position: "absolute", inset: 0, pointerEvents: "none" };

let grainTile: string | null | undefined;

function filmGrainTile(): string | null {
  if (grainTile !== undefined) return grainTile;
  grainTile = null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = FILM_GRAIN_SIDE;
    const context = canvas.getContext("2d");
    if (context) {
      const image = context.createImageData(FILM_GRAIN_SIDE, FILM_GRAIN_SIDE);
      image.data.set(filmGrainAlpha());
      context.putImageData(image, 0, 0);
      grainTile = canvas.toDataURL("image/png");
    }
  } catch {
    grainTile = null;
  }
  return grainTile;
}

export function FilmGrain({ grainOpacity, grainScale }: { grainOpacity?: number; grainScale?: number }) {
  const opacity = filmGrainOpacity(grainOpacity);
  const tile = opacity > 0 ? filmGrainTile() : null;
  if (!tile) return null;
  const size = filmGrainSize(grainScale);
  return <div data-ardia-film-grain="" style={{ ...fill, opacity, backgroundImage: `url(${tile})`, backgroundSize: `${size}px ${size}px`, imageRendering: "pixelated" }} />;
}

type Props = { dark: boolean; tintColor?: string; tintAlpha?: number; tintLightness?: number; grainOpacity?: number; grainScale?: number };

export function Vibrancy({ dark, tintColor, tintAlpha = 0.36, tintLightness = 0.25, grainOpacity = 0, grainScale = 1 }: Props) {
  const [top, bottom] = vibrancyStops(dark, tintColor, tintAlpha, tintLightness);
  return (
    <div style={{ ...fill, background: `linear-gradient(to bottom in display-p3, ${displayP3(top, 1)}, ${displayP3(bottom, 1)})` }}>
      <FilmGrain grainOpacity={grainOpacity} grainScale={grainScale} />
    </div>
  );
}
