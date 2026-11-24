import { consentOrNow, countFor } from "./countFor";

const NONE = { share_previews_asked: 0, share_previews_missing: 0, share_preview_failures: 0, share_preview_ms: 0, share_preview_batches: 0 };

let counts = { ...NONE };

export function startSharePreviews(asked: number) {
  const consent = consentOrNow(undefined);
  const started = Date.now();
  return {
    found(missing: number) {
      countFor(consent, () => {
        counts.share_previews_asked += asked;
        counts.share_previews_missing += missing;
        counts.share_preview_ms += Math.max(0, Math.round(Date.now() - started));
        counts.share_preview_batches++;
      });
    },
    failed() {
      countFor(consent, () => void counts.share_preview_failures++);
    },
  };
}

export function takeSharePreviewCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
