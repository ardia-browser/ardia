export const introCanCoverScreen = false;

export function holdWindowHidden(_browserWindowId: string) {}

export function coverScreenForIntro(_browserWindowId: string) {}

export function uncoverScreen(_browserWindowId: string) {}

export function coverOrReveal(_browserWindowId: string, _covers: boolean, _deadlineMs: number): (() => void) | undefined {
  return undefined;
}

export function handOffFromIntro(_burst: boolean, _from?: number) {}

export function closeIntroWindow() {}

export function closeIntroWindowFor(_session: number) {}
