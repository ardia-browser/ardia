import { useEffect, useRef } from "react";
import { devRegister } from "../dev/devRegister";
import { edgeMaskAt, edgeStrength } from "./edgeFade";
import type { StripScroll } from "./stripScroll";
import { EDGE_FADE } from "./tokens";

type Box = { current: number };
type Page = { tabIds: () => string[]; span: (tabId: string) => [number, number] | null; scrolled: Box; viewport: Box; content: Box; clipShown: Box; scroller: StripScroll };

export function useStripDevRegistry(key: string, current: boolean, page: Page) {
  const latest = useRef(page);
  latest.current = page;
  useEffect(
    () =>
      devRegister("topStripPages", key, {
        current: () => current,
        fadeWidth: EDGE_FADE,
        scroll: () => ({ x: latest.current.scrolled.current, viewport: latest.current.viewport.current, content: latest.current.content.current }),
        chips: () => {
          const { tabIds, span, scrolled, viewport, content, clipShown } = latest.current;
          const box = viewport.current - clipShown.current;
          const strength = edgeStrength(scrolled.current, viewport.current, content.current);
          return tabIds().map((id) => {
            const at = span(id);
            if (!at) return { id, start: -1e6, end: -1e6, centre: -1e6, opacity: 1 };
            const centre = at[0] + at[1] / 2;
            return { id, start: at[0], end: at[0] + at[1], centre, opacity: edgeMaskAt(centre - scrolled.current - clipShown.current, box, strength) };
          });
        },
        scrollTo: (x: number) => latest.current.scroller.scrollTo(x),
      }),
    [key, current],
  );
}
