import { cancelProviderSignIn, wasCancelled, type VaultSignInResult } from "./actions";
import { vaultProviderOf } from "./store";
import { noteVaultSignInCancelled } from "../telemetry/vaultCounts";

export type SignInGoal = "unlocked" | "connected";

const reached = (provider: string, goal: SignInGoal) => {
  const state = vaultProviderOf(provider)?.state;
  return state === "unlocked" || (goal === "connected" && state === "locked");
};

export type SignInRequest = {
  run: (request: () => Promise<VaultSignInResult>) => Promise<VaultSignInResult | null>;
  inFlight: () => boolean;
  keepWaiting: (waiting: boolean) => void;
  close: () => void;
};

const inFlight = new Map<string, Promise<VaultSignInResult>>();

export const signInInFlight = (provider: string) => inFlight.has(provider);

export function joinSignIn(provider: string, request: () => Promise<VaultSignInResult>): Promise<VaultSignInResult> {
  const running = inFlight.get(provider);
  if (running) return running;
  const started = request().finally(() => {
    if (inFlight.get(provider) === started) inFlight.delete(provider);
  });
  inFlight.set(provider, started);
  return started;
}

export function signInRequest(provider: string, goal: SignInGoal): SignInRequest {
  let running = 0;
  let open = true;
  let waiting = false;
  return {
    async run(request) {
      running += 1;
      try {
        const result = await joinSignIn(provider, request);
        return open && !wasCancelled(result) ? result : null;
      } finally {
        running -= 1;
      }
    },
    inFlight: () => running > 0 || inFlight.has(provider),
    keepWaiting(next) {
      waiting = next;
    },
    close() {
      if (!open) return;
      open = false;
      if ((running > 0 || waiting) && !reached(provider, goal)) {
        noteVaultSignInCancelled();
        void cancelProviderSignIn(provider);
      }
    },
  };
}
