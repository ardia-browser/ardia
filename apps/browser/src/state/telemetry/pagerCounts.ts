let settles = 0;
let settlesWithoutSwitch = 0;

export function notePagerSettle(switched: boolean) {
  settles++;
  if (!switched) settlesWithoutSwitch++;
}

export function takePagerCounts() {
  const taken = { profile_pager_settles: settles, profile_pager_settles_without_switch: settlesWithoutSwitch };
  settles = 0;
  settlesWithoutSwitch = 0;
  return taken;
}
