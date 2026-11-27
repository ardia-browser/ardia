import { create } from "zustand";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { applePasswordsStatus, cancelApplePasswordsPairing, finishApplePasswordsPairing, onApplePasswordsChanged, pairApplePasswords, type ApplePasswordsPairing, type ApplePasswordsState } from "../../platform/applePasswords";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { noteApplePasswordsPairing, noteApplePasswordsPairingFailed } from "../telemetry/passwordManagerCounts";
import { choosePasswordManager } from "./passwordManager";

export type PairingStep = "starting" | "code" | "checking" | "failed";
export type Pairing = { profileId: string | null; step: PairingStep; error: string | null; consent: ConsentToken | null };
export type { ApplePasswordsState };
type ApplePasswordsStore = { state: ApplePasswordsState | null; pairing: Pairing | null };

export const useApplePasswords = create<ApplePasswordsStore>()(() => ({ state: null, pairing: null }));

const OFFERED: ReadonlySet<ApplePasswordsState> = new Set(["connected", "notConnected", "refused", "helperMissing"]);

export const applePasswordsOffered = (state: ApplePasswordsState | null) => PLATFORM_FEATURES.systemPasswordManagers && state !== null && OFFERED.has(state);

export const useApplePasswordsOffered = () => useApplePasswords((s) => applePasswordsOffered(s.state));

export const applePasswordsConnected = () => useApplePasswords.getState().state === "connected";

let listening = false;
let changes = 0;

export async function loadApplePasswords() {
  if (!PLATFORM_FEATURES.systemPasswordManagers) return;
  if (!listening) {
    listening = true;
    onApplePasswordsChanged((state) => {
      changes += 1;
      useApplePasswords.setState({ state });
    });
  }
  const asked = changes;
  const state = await applePasswordsStatus().catch(() => null);
  if (state && asked === changes) useApplePasswords.setState({ state });
}

export const PAIRING_FAILURES: Record<Exclude<ApplePasswordsPairing, "awaitingCode" | "paired">, string> = {
  wrongCode: "That code didn't match. Enter the new code the Passwords app shows.",
  failed: "Apple Passwords didn't answer. Try again.",
  refused: "Apple Passwords isn't available on this Mac.",
  helperMissing: "Apple Passwords' browser helper is missing from this Mac. Update macOS in System Settings › General › Software Update, then try again.",
  tooOld: "Needs macOS 15.4 or later.",
  notEntitled: "This copy of Ardia can't use Apple Passwords.",
};

export const PAIRING_CODE_DIGITS = 6;

export const pairingPrompt = (step: PairingStep): string | null =>
  step === "starting" ? "Opening the Passwords app…" : step === "failed" ? null : "Enter the six-digit code the Passwords app shows.";

export const pairingCodeInput = (text: string) => text.replace(/\D/g, "").slice(0, PAIRING_CODE_DIGITS);

const setPairing = (pairing: Pairing | null) => useApplePasswords.setState({ pairing });
const current = (pairing: Pairing) => useApplePasswords.getState().pairing === pairing;

function failed(attempt: Pairing, outcome: keyof typeof PAIRING_FAILURES) {
  noteApplePasswordsPairingFailed(outcome, attempt.consent);
  setPairing({ ...attempt, step: outcome === "wrongCode" ? "code" : "failed", error: PAIRING_FAILURES[outcome] });
  if (outcome !== "wrongCode") void loadApplePasswords();
}

export async function startApplePasswordsPairing(profileId: string | null) {
  const attempt: Pairing = { profileId, step: "starting", error: null, consent: consentToken() };
  setPairing(attempt);
  noteApplePasswordsPairing("started", attempt.consent);
  const outcome = await pairApplePasswords().catch((): ApplePasswordsPairing => "failed");
  if (!current(attempt)) return;
  if (outcome === "awaitingCode") return setPairing({ ...attempt, step: "code" });
  if (outcome === "paired") return paired(attempt);
  failed(attempt, outcome);
}

function paired(attempt: Pairing) {
  noteApplePasswordsPairing("paired", attempt.consent);
  changes += 1;
  useApplePasswords.setState({ state: "connected", pairing: null });
  if (attempt.profileId) choosePasswordManager(attempt.profileId, "apple", attempt.consent);
}

export async function submitApplePasswordsCode(code: string): Promise<boolean> {
  const waiting = useApplePasswords.getState().pairing;
  if (!waiting || waiting.step !== "code") return false;
  const attempt: Pairing = { ...waiting, step: "checking", error: null, consent: consentToken() };
  setPairing(attempt);
  const outcome = await finishApplePasswordsPairing(code).catch((): ApplePasswordsPairing => "failed");
  if (!current(attempt)) return false;
  if (outcome === "paired") {
    paired(attempt);
    return true;
  }
  failed(attempt, outcome === "awaitingCode" ? "failed" : outcome);
  return false;
}

export function cancelPairing() {
  if (!useApplePasswords.getState().pairing) return;
  setPairing(null);
  void cancelApplePasswordsPairing()
    .catch(() => null)
    .then(loadApplePasswords);
}
