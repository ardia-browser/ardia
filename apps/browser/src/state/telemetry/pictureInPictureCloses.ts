import type { PictureInPictureState } from "../../platform/media";
import { isSharing, onConsentPeriodChange } from "./choice";

export type PictureInPictureCloser = NonNullable<PictureInPictureState["closedBy"]>;

const none = () => ({ app: { auto: 0, manual: 0 }, chrome: { auto: 0, manual: 0 } });

let closed = none();

onConsentPeriodChange(() => (closed = none()));

export function notePictureInPictureClosed(closedBy: PictureInPictureCloser, auto: boolean) {
  if (!isSharing() || !(closedBy in closed)) return;
  closed[closedBy][auto ? "auto" : "manual"]++;
}

export function takePictureInPictureCloseCounts() {
  const taken = closed;
  closed = none();
  return {
    pip_closed_auto_by_app: taken.app.auto,
    pip_closed_auto_by_chrome: taken.chrome.auto,
    pip_closed_manual_by_app: taken.app.manual,
    pip_closed_manual_by_chrome: taken.chrome.manual,
  };
}
