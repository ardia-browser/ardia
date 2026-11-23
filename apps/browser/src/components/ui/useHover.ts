import { createContext, useCallback, useContext, useRef, useState } from "react";
import { markHoverProps } from "../../lib/hoverMarks";

export const Offstage = createContext(false);

export function useOffstage() {
  return useContext(Offstage);
}

export function useHover() {
  const offstage = useContext(Offstage);
  const latest = useRef(offstage);
  latest.current = offstage;
  const [hovered, setHovered] = useState(false);
  const [hoverProps] = useState(() => markHoverProps({ onMouseEnter: () => setHovered(!latest.current), onMouseLeave: () => setHovered(false) }));
  const clearHover = useCallback(() => setHovered(false), []);
  return { hovered: hovered && !offstage, hoverProps, clearHover };
}

export function useTooltip(text: string | undefined) {
  return useContext(Offstage) ? undefined : text;
}
