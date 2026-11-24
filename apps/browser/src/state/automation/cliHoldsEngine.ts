import { withDeadline } from "../../lib/deadline";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { setControlHeldTabs } from "../../platform/control";
import { cliHoldsLeft, drainDisconnectReleases, onCliHoldsChanged } from "../tabs/cliHolds";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { noteChromeDiscardsKeptForCli, noteCliHoldsReleasedOnDisconnect } from "../telemetry/tabSleepCounts";

export const CLI_HOLD_REFRESH_MS = 10_000;
export const CLI_HOLD_PUSH_MS = 3_000;

let watching = false;
let pushing: Promise<ReadonlySet<string> | null> = Promise.resolve(new Set());
let countingSince: ConsentToken | null = null;
let refresh: ReturnType<typeof setInterval> | null = null;

export function pushCliHoldsToEngine(consent: ConsentToken | null): Promise<ReadonlySet<string> | null> {
  keepRefreshing(cliHoldsLeft().length > 0);
  noteCliHoldsReleasedOnDisconnect(drainDisconnectReleases(), consent);
  pushing = pushing.then(async () => {
    const tabs = cliHoldsLeft();
    try {
      const answer = await withDeadline(setControlHeldTabs(tabs), CLI_HOLD_PUSH_MS, null);
      if (answer === null) return null;
      noteChromeDiscardsKeptForCli(answer.kept, countingSince);
      countingSince = consent;
      return new Set(answer.marked);
    } catch {
      return null;
    }
  });
  return pushing;
}

export const cliHoldsPushed = (): Promise<ReadonlySet<string> | null> => pushing;

function keepRefreshing(on: boolean): void {
  if (on && refresh === null) refresh = setInterval(holdsChanged, CLI_HOLD_REFRESH_MS);
  if (!on && refresh !== null) {
    clearInterval(refresh);
    refresh = null;
  }
}

function holdsChanged(): void {
  void pushCliHoldsToEngine(consentToken());
}

export function watchCliHoldsForEngine(): void {
  if (watching || !PLATFORM_FEATURES.vetoesChromeDiscardsForCli) return;
  watching = true;
  onCliHoldsChanged(holdsChanged);
  holdsChanged();
}
