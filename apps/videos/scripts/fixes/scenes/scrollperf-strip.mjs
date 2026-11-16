import { scrollScene } from "./scrollperf.mjs";

export default scrollScene({
  session: "session-scroll-perf-strip.json",
  region: [90, 2, 1180, 38],
  point: [700, 20],
  gestures: ["flick-x", "flick-x reverse", "flick-x", "flick-x reverse"],
});
