import { closeWindow, openWindow, setWindowShown } from "../../platform/windows";
import { isWebDemo } from "./demoSteps";
import { INTRO_WINDOW_ID } from "./introWindow";
import { goToStep, useOnboarding } from "./onboarding";

export const introCanCoverScreen = !isWebDemo;

const INTRO_WINDOW_LINGER_MS = 900;
const CARD_AFTER_WINDOW_MS = 300;

let lingering: ReturnType<typeof setTimeout> | null = null;

function stopLingering() {
  if (lingering !== null) clearTimeout(lingering);
  lingering = null;
}

export function holdWindowHidden(browserWindowId: string) {
  void setWindowShown(browserWindowId, false);
}

export function coverScreenForIntro(browserWindowId: string) {
  stopLingering();
  void setWindowShown(browserWindowId, false);
  void openWindow(INTRO_WINDOW_ID, { kind: "intro", title: "Ardia", cover: browserWindowId });
}

export function uncoverScreen(browserWindowId: string) {
  void setWindowShown(browserWindowId, true);
  stopLingering();
  lingering = setTimeout(() => {
    lingering = null;
    closeIntroWindow();
  }, INTRO_WINDOW_LINGER_MS);
}

export function coverOrReveal(browserWindowId: string, covers: boolean, deadlineMs: number): (() => void) | undefined {
  if (!covers) {
    void setWindowShown(browserWindowId, true);
    return undefined;
  }
  const { session } = useOnboarding.getState();
  coverScreenForIntro(browserWindowId);
  const stalled = setTimeout(() => {
    const now = useOnboarding.getState();
    if (now.session === session && now.step === "intro") handOffFromIntro(false, session);
  }, deadlineMs);
  return () => {
    clearTimeout(stalled);
    uncoverScreen(browserWindowId);
  };
}

export function handOffFromIntro(burst: boolean, from: number = useOnboarding.getState().session) {
  const { windowId, session } = useOnboarding.getState();
  if (session !== from) return;
  if (windowId) void setWindowShown(windowId, true, burst);
  setTimeout(() => {
    const now = useOnboarding.getState();
    if (now.session === session && now.step === "intro") goToStep("source");
  }, CARD_AFTER_WINDOW_MS);
}

export function closeIntroWindow() {
  void closeWindow(INTRO_WINDOW_ID);
}

export function closeIntroWindowFor(session: number) {
  if (useOnboarding.getState().session === session) closeIntroWindow();
}
