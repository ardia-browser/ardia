import { consentToken, type ConsentToken } from "./consentPeriod";

let printing: { consent: ConsentToken | null } | null = null;

export const logConsent = (): ConsentToken | null => (printing ? printing.consent : consentToken());

function printFor(level: "warn" | "error", consent: ConsentToken | null, args: unknown[]) {
  const outer = printing;
  printing = { consent };
  try {
    console[level](...args);
  } finally {
    printing = outer;
  }
}

export const warnFor = (consent: ConsentToken | null, ...args: unknown[]) => printFor("warn", consent, args);
export const errorFor = (consent: ConsentToken | null, ...args: unknown[]) => printFor("error", consent, args);
