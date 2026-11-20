import type { ConsentToken } from "../telemetry/choice";
import { claimChromeDropdownKinds, type ChromeDropdownKind, type ChromeDropdownShown } from "../../platform/vaults";
import { noteChromeDropdownHidden } from "../telemetry/vaultCounts";

export type { ChromeDropdownKind, ChromeDropdownShown };

export type ChromeDropdownClaim = { hidden: boolean; showing: ChromeDropdownShown[]; logins: string[] };
export type ChromeDropdownLogins = readonly string[] | null;

type Claim = { kinds: readonly ChromeDropdownKind[]; logins: ChromeDropdownLogins };

const NOTHING: ChromeDropdownClaim = { hidden: false, showing: [], logins: [] };
const claims = new Map<string, Map<string, Claim>>();
const sent = new Map<string, string>();

function unionOf(tabId: string) {
  const kinds = new Set<ChromeDropdownKind>();
  let logins: Set<string> | null = new Set();
  for (const claim of claims.get(tabId)?.values() ?? []) {
    for (const kind of claim.kinds) kinds.add(kind);
    if (!claim.kinds.includes("login")) continue;
    if (claim.logins === null) logins = null;
    else if (logins) for (const login of claim.logins) logins.add(login.toLowerCase());
  }
  return { kinds: [...kinds].sort(), logins: logins && [...logins].sort() };
}

export const claimedChromeDropdownKinds = (tabId: string): ChromeDropdownKind[] => unionOf(tabId).kinds;

export async function claimChromeDropdowns(tabId: string, source: string, kinds: readonly ChromeDropdownKind[], logins: ChromeDropdownLogins, consent: ConsentToken | null): Promise<ChromeDropdownClaim> {
  const bySource = claims.get(tabId) ?? new Map<string, Claim>();
  if (kinds.length) bySource.set(source, { kinds: [...kinds], logins: logins && [...logins] });
  else bySource.delete(source);
  if (bySource.size) claims.set(tabId, bySource);
  else claims.delete(tabId);
  const union = unionOf(tabId);
  const key = union.kinds.length ? JSON.stringify(union) : "";
  if ((sent.get(tabId) ?? "") === key) return NOTHING;
  if (key) sent.set(tabId, key);
  else sent.delete(tabId);
  const answer = await claimChromeDropdownKinds(tabId, union.kinds, union.logins).catch(() => {
    if ((sent.get(tabId) ?? "") === key) sent.delete(tabId);
    return NOTHING;
  });
  if (answer.hidden) noteChromeDropdownHidden(consent);
  return answer;
}

export async function closeChromeDropdown(tabId: string, consent: ConsentToken | null) {
  const union = unionOf(tabId);
  const answer = await claimChromeDropdownKinds(tabId, ["login", "history", "address", "card", "other"], null).catch(() => NOTHING);
  await claimChromeDropdownKinds(tabId, union.kinds, union.logins).catch(() => null);
  if (answer.hidden) noteChromeDropdownHidden(consent);
  return answer.hidden;
}

export function forgetChromeDropdownClaims(tabId: string) {
  claims.delete(tabId);
  sent.delete(tabId);
}
