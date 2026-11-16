import { scrollScene } from "./scrollperf.mjs";

export default scrollScene({
  session: "session-scroll-perf-sidebar.json",
  region: [0, 140, 270, 620],
  point: [130, 460],
  boot: 10000,
  gestures: ["flick", "flick reverse", "flick", "flick reverse"],
});
