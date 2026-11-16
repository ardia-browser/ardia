export default {
  session: "session-0247n3-width.json",
  setup: `return sleep(2500).then(() => done());`,
  act: `const toggle = () => key("⌘S", CMD, "s", 1).then(() => sleep(1700));
return at(700, 520).then(() => sleep(700))
  .then(() => { mark("go"); return toggle(); }).then(toggle).then(toggle).then(toggle)
  .then(() => done({ hidden: st().windows[W].autoHideTabs ?? st().settings.autoHideTabs }));`,
  tail: 500,
};
