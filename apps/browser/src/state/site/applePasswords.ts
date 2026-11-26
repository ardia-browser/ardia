import { create } from "zustand";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { applePasswordsStatus, cancelApplePasswordsPairing, finishApplePasswordsPairing, pairApplePasswords, type ApplePasswordsPairing, type ApplePasswordsState } from "../../platform/applePasswords";
import { choosePasswordManager } from "./passwordManager";

export type PairingStep = "starting" | "code" | "checking" | "failed";
export type Pairing = { profileId: string | null; step: PairingStep; error: string | null };
type ApplePasswordsStore = { state: ApplePasswordsState | null; pairing: Pairing | null };

export const useApplePasswords = create<ApplePasswordsStore>()(() => ({ state: null, pairing: null }));

const OFFERED: ReadonlySet<ApplePasswordsState> = new Set(["connected", "notConnected", "refused", "helperMissing"]);

export const applePasswordsOffered = (state: ApplePasswordsState | null) => PLATFORM_FEATURES.systemPasswordManagers && state !== null && OFFERED.has(state);

export const useApplePasswordsOffered = () => useApplePasswords((s) => applePasswordsOffered(s.state));

export const applePasswordsConnected = () => useApplePasswords.getState().state === "connected";

export async function loadApplePasswords() {
  if (!PLATFORM_FEATURES.systemPasswordManagers) return;
  const state = await applePasswordsStatus().catch(() => null);
  if (state) useApplePasswords.setState({ state });
}

export const PAIRING_FAILURES: Record<Exclude<ApplePasswordsPairing, "awaitingCode" | "paired">, string> = {
  wrongCode: "That code didn't match. Enter the new code the Passwords app shows.",
  failed: "Apple Passwords didn't answer. Try again.",
  refused: "Apple Passwords isn't available on this Mac.",
  helperMissing: "Apple Passwords' browser helper isn't on this Mac.",
  tooOld: "Needs macOS 15.4 or later.",
  notEntitled: "This copy of Ardia can't use Apple Passwords.",
};

const setPairing = (pairing: Pairing | null) => useApplePasswords.setState({ pairing });
const current = (pairing: Pairing) => useApplePasswords.getState().pairing === pairing;

function failed(attempt: Pairing, outcome: keyof typeof PAIRING_FAILURES) {
  setPairing({ ...attempt, step: outcome === "wrongCode" ? "code" : "failed", error: PAIRING_FAILURES[outcome] });
  if (outcome !== "wrongCode") void loadApplePasswords();
}

export async function startApplePasswordsPairing(profileId: string | null) {
  const attempt: Pairing = { profileId, step: "starting", error: null };
  setPairing(attempt);
  const outcome = await pairApplePasswords().catch((): ApplePasswordsPairing => "failed");
  if (!current(attempt)) return;
  if (outcome === "awaitingCode") return setPairing({ ...attempt, step: "code" });
  if (outcome === "paired") return paired(attempt);
  failed(attempt, outcome);
}

function paired(attempt: Pairing) {
  useApplePasswords.setState({ state: "connected", pairing: null });
  if (attempt.profileId) choosePasswordManager(attempt.profileId, "apple");
}

export async function submitApplePasswordsCode(code: string) {
  const waiting = useApplePasswords.getState().pairing;
  if (!waiting || waiting.step !== "code") return;
  const attempt: Pairing = { ...waiting, step: "checking", error: null };
  setPairing(attempt);
  const outcome = await finishApplePasswordsPairing(code).catch((): ApplePasswordsPairing => "failed");
  if (!current(attempt)) return;
  if (outcome === "paired") return paired(attempt);
  failed(attempt, outcome === "awaitingCode" ? "failed" : outcome);
}

export function cancelPairing() {
  if (!useApplePasswords.getState().pairing) return;
  setPairing(null);
  void cancelApplePasswordsPairing()
    .catch(() => null)
    .then(loadApplePasswords);
}
