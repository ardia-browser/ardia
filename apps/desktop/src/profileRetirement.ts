import { onProfileDeleted } from "../../browser/src/state/profiles/profiles";

type ProfilesStore = { getState(): { profiles: Record<string, unknown> }; subscribe(listener: (state: { profiles: Record<string, unknown> }) => void): () => void };

export const PROFILE_GONE_WAIT_MS = 20_000;
export const FORWARD_RETRY_MS = 15_000;
export const FORWARD_TRIES = 40;

type Timers = { set: (done: () => void, ms: number) => unknown; clear: (handle: unknown) => void };

const realTimers: Timers = { set: (done, ms) => setTimeout(done, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export function deliverToAuthority<T>(leading: () => boolean, send: (value: T) => Promise<unknown>, here: (value: T) => void, timers = realTimers): (value: T) => void {
  const attempt = (value: T, left: number) => {
    if (leading()) return here(value);
    send(value).catch(() => {
      if (left > 1) timers.set(() => attempt(value, left - 1), FORWARD_RETRY_MS);
    });
  };
  return (value) => attempt(value, FORWARD_TRIES);
}

export function forwardProfileDeletions(leading: () => boolean, send: (profileId: string) => Promise<unknown>, retireHere: (profileId: string) => void, timers = realTimers): () => void {
  const deliver = deliverToAuthority(leading, send, retireHere, timers);
  return onProfileDeleted((profileId) => {
    if (!leading()) deliver(profileId);
  });
}

export function whenProfileGone(store: ProfilesStore, profileId: string, then: () => void, wait = PROFILE_GONE_WAIT_MS, timers = realTimers): Promise<void> {
  if (!store.getState().profiles[profileId]) return Promise.resolve(then());
  return new Promise<void>((resolve, reject) => {
    const stop = store.subscribe((state) => {
      if (state.profiles[profileId]) return;
      stop();
      timers.clear(timer);
      then();
      resolve();
    });
    const timer = timers.set(() => {
      stop();
      reject(new Error("The deleted profile hasn't reached this window yet"));
    }, wait);
  });
}
