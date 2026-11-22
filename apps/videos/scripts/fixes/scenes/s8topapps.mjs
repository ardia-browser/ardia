export default {
  session: "session-0247n8-topapps.json",
  setup: `st().activate("p1"); return sleep(3000).then(() => { st().activate("n1"); return sleep(1500); }).then(() => done({ tabs: Object.keys(st().tabs).length }));`,
  act: `const tabsNow = () => Object.values(st().tabs).filter((t) => !t.pin).length;
const open = () => !!st().windows[W];
const counts = [];
const closeOnce = () => (open() ? key("⌘W", CMD, "w", 13).catch(() => null) : Promise.resolve()).then(() => sleep(1700)).then(() => counts.push({ open: open(), tabs: tabsNow() }));
return at(700, 420).then(() => sleep(900))
  .then(() => { mark("go"); return closeOnce(); }).then(closeOnce).then(closeOnce)
  .then(() => sleep(400))
  .then(() => JSON.stringify({ events, counts, closed: !open() }));`,
  tail: 600,
};
