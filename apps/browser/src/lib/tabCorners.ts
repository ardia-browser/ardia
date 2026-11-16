import type { ThemeLook } from "./themeLook";

export const TAB_CORNERS = { min: 0, max: 20 } as const;

export const validTabCorners = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isInteger(value) && value >= TAB_CORNERS.min && value <= TAB_CORNERS.max);

export function withTabCorners(look: ThemeLook, corners: number | null): ThemeLook {
  if (corners === null || corners === look.radii.chrome) return look;
  return { ...look, radii: { ...look.radii, chrome: corners } };
}

export function tabCornersControl(inForce: number, chosen: number | null) {
  return {
    position: Math.min(1, Math.max(0, inForce / TAB_CORNERS.max)),
    label: inForce === 0 ? "Square" : `${inForce} pt`,
    followsTheme: chosen === null,
  };
}
