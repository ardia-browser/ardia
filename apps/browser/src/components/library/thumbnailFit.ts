export type PixelSize = { width: number; height: number };

export const MAX_THUMBNAIL_POINTS = 1024;
export const LONGEST_SHOWN_ASPECT = 3;

export const aspectOf = (size: PixelSize): number => size.width / size.height;

export const shownAspect = (aspect: number): number => Math.min(LONGEST_SHOWN_ASPECT, Math.max(1 / LONGEST_SHOWN_ASPECT, aspect));

export const cropsToShow = (aspect: number): boolean => shownAspect(aspect) !== aspect;

export function fitInBox(box: number, aspect: number): PixelSize {
  const shown = shownAspect(aspect);
  return shown >= 1 ? { width: box, height: box / shown } : { width: box * shown, height: box };
}

export function sharperPoints(points: number, size: PixelSize): number | null {
  const stretch = Math.max(size.width / size.height, size.height / size.width);
  if (!Number.isFinite(stretch) || stretch <= LONGEST_SHOWN_ASPECT) return null;
  const wanted = Math.min(MAX_THUMBNAIL_POINTS, Math.ceil(points * stretch));
  return wanted > points ? wanted : null;
}

export const validSize = (size: unknown): size is PixelSize =>
  typeof size === "object" && size !== null &&
  Number.isFinite((size as PixelSize).width) && Number.isFinite((size as PixelSize).height) &&
  (size as PixelSize).width > 0 && (size as PixelSize).height > 0;

export const dimensionsLabel = (size: PixelSize): string => `${size.width} × ${size.height}`;
