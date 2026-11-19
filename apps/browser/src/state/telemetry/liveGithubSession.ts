import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

let sessionFetches = 0;
let sessionPulls = 0;
let sessionSignedOut = 0;
let signInOpens = 0;

export function noteLiveGithubSession(consent: ConsentToken | null, pulls: number) {
  countFor(consent, () => { sessionFetches++; sessionPulls += pulls; });
}

export function noteLiveGithubSessionSignedOut(consent: ConsentToken | null) {
  countFor(consent, () => void sessionSignedOut++);
}

export function noteLiveGithubSignInOpen(consent: ConsentToken | null) {
  countFor(consent, () => void signInOpens++);
}

export function takeLiveGithubSessionCounts() {
  const taken = { live_github_session_fetches: sessionFetches, live_github_session_pulls: sessionPulls, live_github_session_signed_out: sessionSignedOut, live_github_sign_in_opens: signInOpens };
  sessionFetches = 0;
  sessionPulls = 0;
  sessionSignedOut = 0;
  signInOpens = 0;
  return taken;
}
