let turnedOn = 0;
let turnedOff = 0;

export function noteMinimalismToggled(on: boolean) {
  if (on) turnedOn++;
  else turnedOff++;
}

export function takeMinimalismCounts() {
  const taken = { minimalism_turned_on: turnedOn, minimalism_turned_off: turnedOff };
  turnedOn = 0;
  turnedOff = 0;
  return taken;
}
