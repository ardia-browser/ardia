export type FadeEdge = { length: number; floor?: number };

export type FadeEdges = { top?: FadeEdge; bottom?: FadeEdge; leading?: FadeEdge; trailing?: FadeEdge };

export const NATIVE_FADE_PROPS = { top: "topFade", bottom: "bottomFade", leading: "leadingFade", trailing: "trailingFade" } as const;

export function nativeFadeProps(edges: FadeEdges, names: Record<keyof FadeEdges, string> = NATIVE_FADE_PROPS): Record<string, FadeEdge> {
  const out: Record<string, FadeEdge> = {};
  for (const edge of ["top", "bottom", "leading", "trailing"] as const) {
    const value = edges[edge];
    if (value) out[names[edge]] = value;
  }
  return out;
}
