export default {
  session: "session-0247n7-little.json",
  env: { FIXES_SELFREC_CROP: "215,72,900,640" },
  minWidth: 850,
  setup: `const id = ac.airTraffic.openLittleArdia("http://docpad.example/");
return sleep(4000).then(() => done({ little: id, frame: st().windows[id].frame, dots: st().settings.showProfileDots }));`,
  act: `return sleep(300).then(() => { mark("go"); return sleep(4500); }).then(() => done());`,
  tail: 500,
};
