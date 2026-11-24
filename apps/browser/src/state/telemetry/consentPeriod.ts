export type ConsentToken = string & { readonly consentPeriod: unique symbol };

let current: ConsentToken | null = null;

export const setConsentPeriod = (sharing: boolean, epoch: string | null) => void (current = sharing && epoch ? (epoch as ConsentToken) : null);
export const consentToken = (): ConsentToken | null => current;
export const stillValid = (token: ConsentToken | null | undefined) => typeof token === "string" && token === current;

export function counted(token: ConsentToken | null, count: () => void, local?: () => void) {
  if (stillValid(token)) count();
  else local?.();
}

export const fieldName = (key: string) => key.replace(/([wW])ebKit/g, "$1ebkit").replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

export const fieldsOf = (add: Record<string, number | undefined>, renamed: Record<string, string | undefined> = {}) =>
  Object.fromEntries(Object.entries(add).map(([key, n]) => [renamed[key] ?? fieldName(key), n ?? 0]));

export const consentOrNow = (consent: ConsentToken | null | undefined): ConsentToken | null => (consent === undefined ? current : consent);

export function countFor(consent: ConsentToken | null, count: () => void) {
  if (stillValid(consent)) count();
}
