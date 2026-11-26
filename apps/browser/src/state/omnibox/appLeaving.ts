import { onAppEvent } from "../../platform/app";

const SETTLE_MS = 60;

let watching = false;
let leftAt = -1;

export function watchAppLeaving() {
  if (watching) return;
  watching = true;
  onAppEvent((e) => e.type === "resignActive" && (leftAt = performance.now()));
}

export function cancelUnlessLeavingApp(cancel: () => void) {
  const blurredAt = performance.now();
  setTimeout(() => leftAt < blurredAt && cancel(), SETTLE_MS);
}
