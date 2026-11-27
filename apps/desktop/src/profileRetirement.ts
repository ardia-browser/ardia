import { onProfileDeleted } from "../../browser/src/state/profiles/profiles";

type ProfilesStore = { getState(): { profiles: Record<string, unknown> }; subscribe(listener: (state: { profiles: Record<string, unknown> }) => void): () => void };

export const PROFILE_GONE_WAIT_MS = 60_000;

export function forwardProfileDeletions(leading: () => boolean, send: (profileId: string) => void): () => void {
  return onProfileDeleted((profileId) => {
    if (!leading()) send(profileId);
  });
}

type Timers = { set: (done: () => void, ms: number) => unknown; clear: (handle: unknown) => void };

const realTimers: Timers = { set: (done, ms) => setTimeout(done, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export function whenProfileGone(store: ProfilesStore, profileId: string, then: () => void, wait = PROFILE_GONE_WAIT_MS, timers = realTimers) {
  if (!store.getState().profiles[profileId]) return then();
  const stop = store.subscribe((state) => {
    if (state.profiles[profileId]) return;
    finish();
    then();
  });
  const timer = timers.set(finish, wait);
  function finish() {
    stop();
    timers.clear(timer);
  }
}
