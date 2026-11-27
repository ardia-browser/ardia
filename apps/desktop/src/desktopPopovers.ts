import { ardiaHost } from "./host";
import { createPopoverHost, domPopoverDeps, popoverCapabilities, type PopoverHost } from "./popoverHost";

let shared: PopoverHost | null | undefined;

const detachedPopover = () => ({ element: document.createElement("div"), place: () => {}, unmount: () => {} });

export function nativePopovers(): PopoverHost | null {
  if (shared !== undefined) return shared;
  shared = ardiaHost && popoverCapabilities(ardiaHost).childPanels ? createPopoverHost(domPopoverDeps(ardiaHost, detachedPopover, null)) : null;
  return shared;
}
