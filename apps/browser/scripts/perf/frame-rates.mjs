export const DRAW = "ProxyImpl::ScheduledActionDraw";
export const MAIN = "ProxyMain::BeginMainFrame";
const ACTIVATE = "ProxyImpl::DidActivateSyncTreeOnImplThread";

export const rate = (ts) => (ts.length > 1 ? +((1000 * (ts.length - 1)) / (ts.at(-1) - ts[0])).toFixed(1) : null);
export const intervals = (ts) => ts.slice(1).map((t, i) => t - ts[i]);

export const eventTimes = (events, pid, name, t0, t1, phases = ["X", "B"]) =>
  events.filter((e) => e.pid === pid && e.name === name && e.ts >= t0 && e.ts <= t1 && phases.includes(e.ph)).map((e) => e.ts / 1000).sort((a, b) => a - b);

export function frameRates(events, pid, t0, t1, refreshMs) {
  const draws = eventTimes(events, pid, DRAW, t0, t1);
  const mains = eventTimes(events, pid, MAIN, t0, t1);
  const activations = eventTimes(events, pid, ACTIVATE, t0, t1, ["X", "B", "I"]);
  let stale = 0;
  for (let i = 1, a = 0; i < draws.length; i++) {
    let fresh = false;
    for (; a < activations.length && activations[a] <= draws[i]; a++) if (activations[a] > draws[i - 1]) fresh = true;
    if (!fresh) stale++;
  }
  return {
    mains: mains.length,
    draws: draws.length,
    mainHz: rate(mains),
    drawHz: rate(draws),
    drawsLate: intervals(draws).filter((g) => g > refreshMs * 1.5).length,
    stalePct: draws.length > 1 ? Math.round((100 * stale) / (draws.length - 1)) : null,
  };
}
