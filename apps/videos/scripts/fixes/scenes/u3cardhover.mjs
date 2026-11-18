export default {
  session: "session-0247n3-player.json",
  switches: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  setup: `return sleep(3000).then(() => { st().activate("t1"); return sleep(2500); }).then(() => done({ media: ac.media.getState().sessions.v1?.playbackState ?? "none" }));`,
  act: `return at(600, 560).then(() => sleep(700))
  .then(() => move(150, 691, 700)).then(() => { mark("go"); return sleep(1800); })
  .then(() => move(560, 600, 600)).then(() => sleep(1500))
  .then(() => move(150, 691, 600)).then(() => sleep(1800))
  .then(() => move(560, 600, 600)).then(() => sleep(1500))
  .then(() => done());`,
  tail: 500,
};
