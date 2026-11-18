export type PosterShape = { aspect: number; horizon: number };

export function nearestPoster<Poster extends PosterShape>(posters: readonly Poster[], aspect: number): Poster | null {
  let best: Poster | null = null;
  for (const poster of posters) if (!best || Math.abs(Math.log(poster.aspect / aspect)) < Math.abs(Math.log(best.aspect / aspect))) best = poster;
  return best;
}

export function posterFrame(poster: PosterShape, size: { width: number; height: number }) {
  const scale = Math.max(size.width / poster.aspect, size.height);
  const width = poster.aspect * scale;
  const height = scale;
  return { left: (size.width - width) / 2, top: (size.height - height) * poster.horizon, width, height };
}
