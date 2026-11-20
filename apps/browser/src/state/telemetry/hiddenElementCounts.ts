import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

const NONE = { hidden: 0, hiddenPrivate: 0, restored: 0, cancels: 0, contextMenuStarts: 0, failures: 0 };
let counts = { ...NONE };

export function noteElementHidden(inPrivateWindow: boolean, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void (counts.hidden++, inPrivateWindow && counts.hiddenPrivate++));
}

export const noteHiddenElementsRestored = (n: number, consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void (counts.restored += n));
export const noteElementPickerCancelled = (consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void counts.cancels++);
export const noteElementPickerFromContextMenu = () => void counts.contextMenuStarts++;
export const noteHiddenElementWriteFailure = (consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void counts.failures++);

export function takeHiddenElementCounts() {
  const taken = {
    elements_hidden: counts.hidden,
    elements_hidden_private: counts.hiddenPrivate,
    hidden_elements_restored: counts.restored,
    element_picker_cancels: counts.cancels,
    element_picker_context_menu_starts: counts.contextMenuStarts,
    hidden_element_write_failures: counts.failures,
  };
  counts = { ...NONE };
  return taken;
}
