import { useCallback } from "react";
import { focusForScreenReader, type FocusTarget } from "./coverFocus";
import { useOverlayAfterClear, useOverlayCovered, useOverlayGeneration, useOverlayOpened } from "./Overlay";

export function useFocusReturn() {
  const afterClear = useOverlayAfterClear();
  const generation = useOverlayGeneration();
  const covered = useOverlayCovered();
  const onOpened = useOverlayOpened();
  return useCallback(
    (target: FocusTarget, still: () => boolean = () => true) => {
      let cancelFocus: () => void = () => undefined;
      let stopWatching: () => void = () => undefined;
      const openedBefore = generation();
      const stopWaiting = afterClear(() => {
        cancelFocus = focusForScreenReader(target, () => generation() === openedBefore && !covered() && still(), { returning: true });
      });
      const cancel = () => {
        stopWaiting();
        cancelFocus();
        stopWatching();
      };
      stopWatching = onOpened(cancel);
      return cancel;
    },
    [afterClear, generation, covered, onOpened],
  );
}
