import type { ArdiaHost } from "./host";
import type { LaunchClaim } from "./appServices";
import { showToast } from "../../browser/src/state/app/toasts";
import { useOnboarding } from "../../browser/src/state/onboarding/onboarding";
import { noteUnsandboxedLaunch } from "../../browser/src/state/telemetry/updateCounts.ts";

export function sandboxNotice(decision: string | undefined): { title: string; message: string } | null {
  if (!decision) return null;
  const reason = decision.replace(/\s+/g, " ").trim().slice(0, 300);
  return {
    title: "Ardia is running without Chromium's sandbox",
    message: `${reason}. Start Ardia without --no-sandbox to turn the sandbox back on.`,
  };
}

type OnboardingWatch = { open(): boolean; closed(): Promise<void> };

const onboarding: OnboardingWatch = {
  open: () => useOnboarding.getState().windowId !== null,
  closed: () => new Promise((resolve) => {
    const stop = useOnboarding.subscribe((state) => {
      if (state.windowId !== null) return;
      stop();
      resolve();
    });
  }),
};

export async function noticeUnsandboxedLaunch(host: ArdiaHost, windowId: string, launch: Promise<LaunchClaim>, show = showToast, intro: OnboardingWatch = onboarding) {
  const notice = sandboxNotice(host.bootstrap.sandboxDecision);
  if (!notice || (await launch) !== "ran") return false;
  noteUnsandboxedLaunch();
  if (intro.open()) await intro.closed();
  show(windowId, notice.title, notice.message, { icon: "exclamationmark.triangle", sticky: true, key: "linux-sandbox" });
  return true;
}
