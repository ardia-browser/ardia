import { consentedCount } from "./consentedCount";

const steps = consentedCount();
const mergedSteps = consentedCount();

export const noteCommandScrollZoom = (scroll: string | undefined) => {
  if (scroll !== "wheel" && scroll !== "merged") return;
  steps.note();
  if (scroll === "merged") mergedSteps.note();
};

export const takeCommandScrollZoomCounts = () => ({ command_scroll_zoom_steps: steps.take(), command_scroll_zoom_merged_steps: mergedSteps.take() });
