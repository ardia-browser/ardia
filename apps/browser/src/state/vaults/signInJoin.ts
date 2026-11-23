import type { VaultSignInResult } from "./actions";

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
