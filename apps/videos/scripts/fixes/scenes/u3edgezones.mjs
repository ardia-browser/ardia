export default {
  session: "session-0247n3-edge.json",
  setup: `return sleep(1500).then(() => at(520, 300)).then(() => sleep(2000)).then(() => done({ hidden: st().settings.autoHideTabs }));`,
  act: `const crawl = (x0, x1, y, ms) => { const steps = Math.round(ms / 33); const step = (i) => i > steps ? Promise.resolve() : at(Math.round((x0 + (x1 - x0) * i / steps) * 10) / 10, y).then(() => sleep(33)).then(() => step(i + 1)); return step(1); };
return at(300, 300).then(() => sleep(600))
  .then(() => move(40, 300, 700)).then(() => sleep(300))
  .then(() => { mark("go"); return crawl(40, 0, 300, 2400); }).then(() => sleep(1400))
  .then(() => move(298, 320, 600)).then(() => { mark("drift"); return sleep(2000); })
  .then(() => move(150, 340, 450)).then(() => { mark("back"); return sleep(1600); })
  .then(() => move(560, 360, 500)).then(() => { mark("away"); return sleep(2000); })
  .then(() => done());`,
  tail: 500,
};
