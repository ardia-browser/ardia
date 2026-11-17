import { useEffect, useState, type MutableRefObject } from "react";
import { useLookBudgetProbe } from "../../platform/look";
import { useReduceTransparency, useReduceMotion } from "../ui";

export type DeckTouchReport = MutableRefObject<(touching: boolean) => void>;

export function DeckLookProbe({ busy, touch }: { busy: boolean; touch: DeckTouchReport }) {
  const [touching, setTouching] = useState(false);
  const reduceMotion = useReduceMotion();
  const reduceTransparency = useReduceTransparency();
  useEffect(() => {
    touch.current = setTouching;
    return () => {
      touch.current = () => undefined;
    };
  }, [touch]);
  useLookBudgetProbe(!busy && !touching, { reduceMotion, reduceTransparency });
  return null;
}
