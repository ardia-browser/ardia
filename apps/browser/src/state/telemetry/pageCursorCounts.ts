import { onCursorRestored } from "../../platform/performance";

const NONE = { page_pointer_restores: 0, page_pointer_hidden_restores: 0 };
let counts = { ...NONE };

onCursorRestored(({ hidden }) => {
  counts.page_pointer_restores++;
  if (hidden) counts.page_pointer_hidden_restores++;
});

export function takePageCursorCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
