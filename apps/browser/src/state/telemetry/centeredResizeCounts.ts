import { onAppEvent } from "../../platform/app";

let centeredResizes = 0;

onAppEvent((e) => {
  if (e.type === "centeredResize") centeredResizes++;
});

export function takeCenteredResizeCounts() {
  const taken = { window_centered_resizes: centeredResizes };
  centeredResizes = 0;
  return taken;
}
