import { create } from "zustand";
import { legacyProgramsInstalled, programRegistry } from "../../platform/plugins";
import { isFields } from "../../lib/decode";
import { type ProgramClaims } from "./appChecks";

export const UNREADABLE_CLAIMS: ProgramClaims = { claims: {}, failClosed: true };

const isName = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);

export function claimsOf(value: unknown): ProgramClaims {
  if (!isFields(value) || !isFields(value.claims) || typeof value.failClosed !== "boolean") return UNREADABLE_CLAIMS;
  const entries = Object.entries(value.claims);
  if (!entries.every(([program, owner]) => isName(program) && isName(owner))) return UNREADABLE_CLAIMS;
  if (!Array.isArray(value.legacyOwners) || !value.legacyOwners.every(isName)) return UNREADABLE_CLAIMS;
  const providers = value.providers === undefined ? {} : isFields(value.providers) && Object.entries(value.providers).every(([name, title]) => isName(name) && typeof title === "string" && title.length <= 60) ? (value.providers as Record<string, string>) : null;
  if (!providers) return UNREADABLE_CLAIMS;
  return { claims: Object.fromEntries(entries) as Record<string, string>, failClosed: value.failClosed, ...(value.providers === undefined ? {} : { providers }) };
}

export const useProgramRegistry = create<{ failClosed: boolean }>()(() => ({ failClosed: false }));

export async function loadProgramClaims(): Promise<ProgramClaims> {
  const claims = await Promise.resolve()
    .then(() => programRegistry())
    .then(claimsOf, () => UNREADABLE_CLAIMS);
  if (useProgramRegistry.getState().failClosed !== claims.failClosed) useProgramRegistry.setState({ failClosed: claims.failClosed });
  return claims;
}

export const REGISTRY_UNREADABLE = "Ardia's list of program names kept for its built-in plugins is missing or damaged, so no program goes on PATH";

export const programsBlocked = () => useProgramRegistry.getState().failClosed;

export const useLegacyInstalls = create<{ owners: string[] }>()(() => ({ owners: [] }));

export async function refreshLegacyInstalls(): Promise<string[]> {
  const found = await Promise.resolve()
    .then(() => legacyProgramsInstalled())
    .catch((): unknown => []);
  const owners = Array.isArray(found) ? found.filter((owner): owner is string => typeof owner === "string") : [];
  if (JSON.stringify(owners) !== JSON.stringify(useLegacyInstalls.getState().owners)) useLegacyInstalls.setState({ owners });
  return owners;
}
