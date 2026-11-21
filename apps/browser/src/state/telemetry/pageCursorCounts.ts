import { onCursorRestored } from "../../platform/performance";
import { capture, counted } from "./client";
import { nativeConsent } from "./nativeConsent";

const NONE = { page_pointer_restores: 0, page_pointer_hidden_restores: 0 };
let counts = { ...NONE };

onCursorRestored((restore) => {
  const hidden = restore.hidden === true;
  counted(
    nativeConsent(restore),
    () => {
      counts.page_pointer_restores++;
      if (hidden) counts.page_pointer_hidden_restores++;
    },
    () => capture("usage_counts", { page_pointer_restores: 1, page_pointer_hidden_restores: hidden ? 1 : 0 }, null),
  );
});

export function takePageCursorCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
