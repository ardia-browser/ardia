import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { View, type ViewProps } from "react-native";
import { noteMissing } from "../missing";
import { symbolLayers, symbolNudge } from "./symbols/data";
import { symbolMarkup, type SymbolWeight } from "./symbols/render";
import { ardiaHost } from "../../host";
import { prefersReducedMotion } from "./gl/clock";
import { SYMBOL_BOUNCE } from "./symbols/bounce";
import { SYMBOL_REPLACE } from "./symbols/replace";

export type SymbolProps = ViewProps & {
  name: string;
  size?: number;
  weight?: SymbolWeight;
  color?: string;
  bounce?: number;
  replace?: boolean;
};

const NATIVE_DEFAULT_POINT_SIZE = 14;
const CANVAS_IN_POINTS = 3;
const GLYPH_ANCHOR = 1;
type SymbolPolicy = { createHTML(markup: string): TrustedHTML };
type SymbolTrustedTypes = { createPolicy(name: string, rules: { createHTML(markup: string): string }): SymbolPolicy };
const trustedTypes = (globalThis as typeof globalThis & { trustedTypes?: SymbolTrustedTypes }).trustedTypes;
const symbolPolicy = ardiaHost && trustedTypes ? trustedTypes.createPolicy("ardia-symbols", { createHTML: (markup) => markup }) : null;

function useBounce(bounce: number | undefined) {
  const glyph = useRef<SVGSVGElement>(null);
  const played = useRef(bounce);
  useEffect(() => {
    if (bounce === played.current) return;
    played.current = bounce;
    if (prefersReducedMotion()) return;
    glyph.current?.animate(
      SYMBOL_BOUNCE.scales.map((scale, i) => ({ transform: `scale(${scale})`, offset: SYMBOL_BOUNCE.offsets[i], easing: SYMBOL_BOUNCE.easing })),
      { duration: SYMBOL_BOUNCE.duration },
    );
  }, [bounce]);
  return glyph;
}

type Ghost = { key: number; markup: string | TrustedHTML; calm: boolean };

function useReplace(glyph: RefObject<SVGSVGElement | null>, name: string, markup: string | TrustedHTML, replace: boolean | undefined) {
  const shown = useRef({ name, markup });
  const [ghost, setGhost] = useState<Ghost | null>(null);
  useLayoutEffect(() => {
    const was = shown.current;
    shown.current = { name, markup };
    if (!replace || was.name === name || !was.markup) return;
    const calm = prefersReducedMotion();
    setGhost({ key: Date.now(), markup: was.markup, calm });
    const R = SYMBOL_REPLACE;
    glyph.current?.animate(
      calm ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: `scale(${R.in.scale})` }, { opacity: 1, transform: "scale(1)" }],
      calm ? R.fade : { duration: R.in.duration, easing: R.in.easing },
    );
  }, [name, markup, replace, glyph]);
  const fadeOut = (node: SVGSVGElement | null, shade: Ghost) => {
    if (!node || node.getAnimations().length) return;
    const R = SYMBOL_REPLACE;
    const run = node.animate(
      shade.calm ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: `scale(${R.out.scale})` }],
      { duration: shade.calm ? R.fade.duration : R.out.duration, easing: shade.calm ? R.fade.easing : R.out.easing, fill: "forwards" },
    );
    run.onfinish = () => setGhost((current) => (current?.key === shade.key ? null : current));
  };
  return { ghost, fadeOut };
}

const GLYPH_STYLE: CSSProperties = { position: "absolute", left: "50%", top: "50%", display: "block", overflow: "visible", pointerEvents: "none", transformOrigin: "0 0" };

export function Symbol({ name, size = NATIVE_DEFAULT_POINT_SIZE, weight = "regular", color, bounce, replace, style, ...props }: SymbolProps) {
  const id = `symbol-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const glyph = useBounce(bounce);
  const layers = symbolLayers(name);
  if (!layers) noteMissing(`symbol ${name}`);
  const canvas = Math.ceil(size * CANVAS_IN_POINTS);
  const markup = useMemo(
    () => {
      if (!layers) return "";
      const markup = symbolMarkup(layers, { pointSize: size, weight, width: canvas, height: canvas, color: color ?? "currentColor", id, nudge: symbolNudge(name, weight, size) });
      return symbolPolicy ? symbolPolicy.createHTML(markup) : markup;
    },
    [layers, name, size, weight, canvas, color, id],
  );
  const { ghost, fadeOut } = useReplace(glyph, name, markup, replace);
  const viewBox = `${canvas / 2} ${canvas / 2} ${GLYPH_ANCHOR} ${GLYPH_ANCHOR}`;
  return (
    <View pointerEvents="none" {...props} style={style}>
      {ghost ? (
        <svg
          key={ghost.key}
          ref={(node) => fadeOut(node, ghost)}
          aria-hidden
          width={GLYPH_ANCHOR}
          height={GLYPH_ANCHOR}
          viewBox={viewBox}
          overflow="visible"
          style={GLYPH_STYLE}
          dangerouslySetInnerHTML={{ __html: ghost.markup }}
        />
      ) : null}
      {layers ? (
        <svg
          ref={glyph}
          aria-hidden
          data-symbol={name}
          width={GLYPH_ANCHOR}
          height={GLYPH_ANCHOR}
          viewBox={viewBox}
          overflow="visible"
          style={GLYPH_STYLE}
          dangerouslySetInnerHTML={{ __html: markup }}
        />
      ) : null}
    </View>
  );
}
