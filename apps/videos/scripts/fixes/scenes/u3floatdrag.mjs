import { DRAG } from "./_47n3.mjs";

export default {
  session: "session-0247n3-hidden.json",
  setup: `return sleep(2500).then(() => done({ hidden: st().settings.autoHideTabs }));`,
  act: `${DRAG}
return at(520, 400).then(() => sleep(600))
  .then(() => move(2, 400, 800)).then(() => sleep(900))
  .then(() => move(140, 470, 600)).then(() => sleep(400))
  .then(() => { mark("go"); mark("body"); return down(); }).then(() => sleep(150))
  .then(() => dragTo(360, 450, 1100)).then(() => sleep(900)).then(up).then(() => { mark("bodyUp"); return sleep(1500); })
  .then(() => move(2, 330, 800)).then(() => sleep(900))
  .then(() => move(266, 330, 600)).then(() => sleep(400))
  .then(() => { mark("edge"); return down(); }).then(() => sleep(150))
  .then(() => dragTo(360, 330, 1000)).then(() => sleep(700)).then(up).then(() => { mark("edgeUp"); return sleep(900); })
  .then(() => move(180, 300, 500)).then(() => sleep(1600))
  .then(() => done({ width: st().settings.sidebarWidth }));`,
  tail: 500,
};
