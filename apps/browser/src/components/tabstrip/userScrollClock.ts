import { consentToken, type ConsentToken } from "../../state/telemetry/client";

export type UserScrollClock = { scrolled(at: number): void; scrolling(): boolean; heldIn(revealStartedIn?: ConsentToken | null): ConsentToken | null };

export function userScrollClock(quietMs: number, now: () => number = () => performance.now()): UserScrollClock {
  let at = -Infinity;
  let startedIn: ConsentToken | null = null;
  return {
    scrolled: (when) => void ((at = when), (startedIn = consentToken())),
    scrolling: () => now() - at < quietMs,
    heldIn: (revealStartedIn = startedIn) => (revealStartedIn === startedIn ? startedIn : null),
  };
}
