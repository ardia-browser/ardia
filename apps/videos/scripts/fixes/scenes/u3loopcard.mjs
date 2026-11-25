export default {
  session: "session-0247n3-player.json",
  switches: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  setup: `return sleep(3000).then(() => done({ media: ac.media.getState().sessions.v1?.playbackState ?? "none" }));`,
  act: `const media = () => ac.media.getState().sessions.v1 || {};
const samples = [];
const sampler = setInterval(() => { const m = media(); samples.push([Date.now(), m.playbackState, m.position, m.timestamp]); }, 250);
return at(700, 520).then(() => sleep(800))
  .then(() => { mark("go"); st().activate("t1"); return sleep(15000); })
  .then(() => { clearInterval(sampler); return done({ last: media(), samples: samples.filter((s, i) => i % 4 === 0) }); });`,
  tail: 500,
};
