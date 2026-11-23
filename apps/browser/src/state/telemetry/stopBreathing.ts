let breathing = 0;
let since: number | null = null;
let breathedMs = 0;

export function noteStopBreathing(on: boolean) {
  const now = Date.now();
  if (on) {
    if (breathing++ === 0) since = now;
    return;
  }
  if (breathing === 0) return;
  if (--breathing === 0 && since !== null) {
    breathedMs += now - since;
    since = null;
  }
}

export function takeStopBreathing(): { stop_breathing_s: number } {
  const now = Date.now();
  const ms = breathedMs + (since === null ? 0 : now - since);
  breathedMs = 0;
  if (since !== null) since = now;
  return { stop_breathing_s: Math.round(ms / 1000) };
}
