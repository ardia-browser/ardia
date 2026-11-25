import { hapticTick } from "../../platform/haptics";
import { useBrowser } from "../browser/store";

export const reorderTick = () => {
  if (useBrowser.getState().settings.tabReorderHaptics) hapticTick();
};
