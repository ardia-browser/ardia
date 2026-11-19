const heldElsewhere = new Set<string>();

export function holdConsentOutsideSettings(name: string): () => void {
  heldElsewhere.add(name);
  return () => heldElsewhere.delete(name);
}

export const settingsOwnsConsent = (consent: { name: string } | null): boolean => !!consent && !heldElsewhere.has(consent.name);
