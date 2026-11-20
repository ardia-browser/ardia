import { useDerivedValue, type SharedValue } from "react-native-reanimated";
import { deckPull, PULL_STAGE, pullFades } from "../../state/browse/deckPull";
import { pullHeld } from "../../lib/deckPull";
import { DECK_PHASE, type Reads } from "./DeckCard";

type Base = {
  orderIds: SharedValue<readonly string[]>;
  phase: SharedValue<number>;
  expandedIndex: SharedValue<number>;
  scaleProgress: SharedValue<number>;
  positionProgress: SharedValue<number>;
  covering: SharedValue<string>;
};

export type DeckPulled = {
  phase: Reads<number>;
  expandedIndex: Reads<number>;
  scaleProgress: Reads<number>;
  positionProgress: Reads<number>;
  riseProgress: Reads<number>;
  revealProgress: Reads<number>;
  covering: Reads<string>;
  pulling: Reads<boolean>;
  waking: Reads<boolean>;
};

export function useDeckPulled(base: Base): DeckPulled {
  const { orderIds } = base;
  const pulling = useDerivedValue(() => deckPull.stage.value !== PULL_STAGE.idle);
  const waking = useDerivedValue(() => pulling.value || deckPull.warm.value);
  const shrinking = useDerivedValue(() => pulling.value && !pullFades(deckPull.stage.value));
  const steady = useDerivedValue(() => deckPull.steady.value && deckPull.stage.value === PULL_STAGE.growing);
  const held = useDerivedValue(() => (shrinking.value && !steady.value ? pullHeld(deckPull.shrink.value) : 1));
  const phase = useDerivedValue(() => (shrinking.value ? DECK_PHASE.pulling : base.phase.value));
  const expandedIndex = useDerivedValue(() => (shrinking.value ? orderIds.value.indexOf(deckPull.id.value) : base.expandedIndex.value));
  const scaleProgress = useDerivedValue(() => (pulling.value ? held.value : base.scaleProgress.value));
  const positionProgress = useDerivedValue(() => (pulling.value ? held.value : base.positionProgress.value));
  const revealProgress = useDerivedValue(() => (pulling.value ? (shrinking.value && !steady.value ? deckPull.reveal.value : 1) : base.positionProgress.value));
  const covering = useDerivedValue(() => {
    const stage = deckPull.stage.value;
    const covered = stage < PULL_STAGE.handed || (stage === PULL_STAGE.growing && deckPull.pageLive.value && !deckPull.steady.value);
    return shrinking.value && covered ? deckPull.id.value : base.covering.value;
  });
  return { phase, expandedIndex, scaleProgress, positionProgress, riseProgress: positionProgress, revealProgress, covering, pulling, waking };
}

export function useBarGlyphFade(pulling: Reads<boolean>, chrome: Reads<number>): Reads<number> {
  return useDerivedValue(() => (pulling.value ? (deckPull.barCleared.value || deckPull.barOwned.value || deckPull.stage.value === PULL_STAGE.handed ? 1 : 0) : chrome.value));
}
