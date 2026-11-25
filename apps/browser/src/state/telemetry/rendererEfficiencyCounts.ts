import { rendererEfficiency } from "../../platform/rendererEfficiency";
import { stillValid, type ConsentToken } from "./client";

const FIELDS = {
  throttled: "background_renderers_throttled",
  restored: "background_renderers_restored",
  failed: "background_renderer_throttle_failures",
  exemptCall: "background_tabs_kept_fast_call",
  exemptCapture: "background_tabs_kept_fast_capture",
  exemptPictureInPicture: "background_tabs_kept_fast_picture_in_picture",
  exemptAudio: "background_tabs_kept_fast_audio",
} as const;

type Field = (typeof FIELDS)[keyof typeof FIELDS];

export function takeRendererEfficiencyCounts(): Partial<Record<Field, number>> {
  const valid = Object.entries(rendererEfficiency.takeCounts()).filter(([epoch]) => stillValid(epoch as ConsentToken));
  if (!valid.length) return {};
  const sent = Object.fromEntries(Object.values(FIELDS).map((field) => [field, 0])) as Record<Field, number>;
  for (const [, raw] of valid) {
    for (const [key, field] of Object.entries(FIELDS) as [keyof typeof FIELDS, Field][]) {
      const n = raw?.[key] ?? 0;
      sent[field] += Number.isSafeInteger(n) && n > 0 ? n : 0;
    }
  }
  return sent;
}
