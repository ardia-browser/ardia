export type ConsentGate = { shownAt: number | null; pressStartedAt: number | null };

export const CLOSED_GATE: ConsentGate = { shownAt: null, pressStartedAt: null };

export const consentShown = (gate: ConsentGate, at: number): ConsentGate => (gate.shownAt === null ? { ...gate, shownAt: at } : gate);

export const consentPressStarted = (gate: ConsentGate, at: number): ConsentGate => ({ ...gate, pressStartedAt: at });

export function consentPressCounts(gate: ConsentGate): boolean {
  if (gate.shownAt === null) return false;
  return gate.pressStartedAt === null || gate.pressStartedAt >= gate.shownAt;
}
