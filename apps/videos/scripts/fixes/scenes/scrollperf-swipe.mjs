import { scrollScene } from "./scrollperf.mjs";

export default scrollScene({
  session: "session-scroll-perf-swipe.json",
  region: [0, 40, 270, 720],
  point: [130, 460],
  gestures: ["flick-x", "flick-x reverse", "flick-x", "flick-x reverse"],
});
