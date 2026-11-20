import { onCursorRestored } from "../../platform/performance";
import { counted } from "./client";
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
  );
});

export function takePageCursorCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
