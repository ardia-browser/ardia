export const INTRO_WINDOW_ID = "onboarding-intro";

let holdForIntro: ((windowId: string) => void) | null = null;

export function provideIntroHold(hold: (windowId: string) => void) {
  holdForIntro = hold;
}

export function holdWindowForIntro(windowId: string) {
  holdForIntro?.(windowId);
}
