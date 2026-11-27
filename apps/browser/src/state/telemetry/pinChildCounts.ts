import { consentOrNow, countFor, type ConsentToken } from "./consentPeriod";

let opened = 0;
let pinned = 0;
let movedOut = 0;

export function notePinChildOpened(consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void opened++);
}

export function notePinChildrenPlaced(nowPinned: number, nowOut: number, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => {
    pinned += nowPinned;
    movedOut += nowOut;
  });
}

export function takePinChildCounts() {
  const taken = { pin_children_opened: opened, pin_children_pinned: pinned, pin_children_moved_out: movedOut };
  opened = 0;
  pinned = 0;
  movedOut = 0;
  return taken;
}
