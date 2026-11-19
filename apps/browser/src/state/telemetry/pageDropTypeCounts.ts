import { onPageDropTypesChanged } from "../../platform/performance";
import { capture, counted } from "./client";
import { nativeConsent } from "./nativeConsent";

let unregistered = 0;
let reregistered = 0;

const whole = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1000) : 0);

onPageDropTypesChanged((e) => {
  const off = whole(e.unregistered);
  const on = whole(e.reregistered);
  if (!off && !on) return;
  counted(
    nativeConsent(e),
    () => {
      unregistered += off;
      reregistered += on;
    },
    () => capture("usage_counts", { page_views_drop_unregistered: off, page_views_drop_reregistered: on }, null),
  );
});

export function takePageDropTypeCounts() {
  const taken = { page_views_drop_unregistered: unregistered, page_views_drop_reregistered: reregistered };
  unregistered = 0;
  reregistered = 0;
  return taken;
}
