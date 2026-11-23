import { useMemo } from "react";
import { create } from "zustand";
import { installOfficialPlugin, useOfficialCredentialProviders, type OfficialCredentialProvider } from "../plugins/official";
import { turnOnApprovedPlugin } from "../plugins/actions";
import { useVaults, vaultProviderOf } from "./store";

export type CatalogueState = "available" | "installed" | "unsupported";
export type CatalogueEntry = { name: string; title: string; blurb: string; icon: string; accent?: string; state: CatalogueState; enabled?: boolean };

export type AddPhase = "installing" | "starting" | "failed";
export type AddingManager = { name: string; title: string; icon: string; accent?: string; phase: AddPhase; reason: string; turningOn?: boolean };
type ManagerLook = Pick<CatalogueEntry, "name" | "title" | "icon" | "accent">;

export const useManagerAdds = create<{ adding: AddingManager | null; preview: CatalogueEntry[] | null }>()(() => ({ adding: null, preview: null }));

export const showPreviewCatalogue = (entries: CatalogueEntry[] | null) => useManagerAdds.setState({ preview: entries });
export const showPreviewAdding = (adding: AddingManager | null) => useManagerAdds.setState({ adding });

export const catalogueEntryOf = (e: OfficialCredentialProvider): CatalogueEntry => ({ name: e.name, title: e.title, blurb: e.blurb, icon: e.symbol, accent: e.accent ?? undefined, state: e.state, enabled: e.enabled });

export function managerOffers(entries: readonly CatalogueEntry[], registered: ReadonlySet<string>): { add: CatalogueEntry[]; off: CatalogueEntry[] } {
  const offered = entries.filter((e) => e.state !== "unsupported" && !registered.has(e.name));
  return { add: offered.filter((e) => e.state === "available"), off: offered.filter((e) => e.state === "installed" && e.enabled !== true) };
}

function useOffers() {
  const official = useOfficialCredentialProviders();
  const preview = useManagerAdds((s) => s.preview);
  const registered = useVaults((s) => s.providers.map((p) => p.id).join(" "));
  return useMemo(() => managerOffers(preview ?? official.map(catalogueEntryOf), new Set(registered ? registered.split(" ") : [])), [official, preview, registered]);
}

export const useManagerCatalogue = (): CatalogueEntry[] => useOffers().add;

export const useOffManagers = (): CatalogueEntry[] => useOffers().off;

export const useAddingManager = () => useManagerAdds((s) => s.adding);

let attempt = 0;

const waitForProvider = (name: string, turn: number) =>
  new Promise<boolean>((resolve) => {
    if (vaultProviderOf(name)) return resolve(true);
    const finish = (arrived: boolean) => {
      stopVaults();
      stopAdds();
      resolve(arrived);
    };
    const stopVaults = useVaults.subscribe(() => {
      if (turn !== attempt) finish(false);
      else if (vaultProviderOf(name)) finish(true);
    });
    const stopAdds = useManagerAdds.subscribe((s) => {
      if (s.adding?.name !== name || turn !== attempt) finish(false);
    });
  });

const adding = (entry: ManagerLook, phase: AddPhase, reason = "", turningOn = false): AddingManager => ({
  name: entry.name,
  title: entry.title,
  icon: entry.icon,
  accent: entry.accent,
  phase,
  reason,
  ...(turningOn ? { turningOn } : {}),
});

async function finishWhenRegistered(entry: ManagerLook, turn: number, turningOn: boolean, onReady: (provider: string) => void) {
  useManagerAdds.setState({ adding: adding(entry, "starting", "", turningOn) });
  if (!(await waitForProvider(entry.name, turn))) return;
  dismissAddingManager();
  const state = vaultProviderOf(entry.name)?.state;
  if (state !== "unlocked" && state !== "locked") onReady(entry.name);
}

export async function addPasswordManager(entry: ManagerLook, onReady: (provider: string) => void) {
  const turn = ++attempt;
  useManagerAdds.setState({ adding: adding(entry, "installing") });
  const result = await installOfficialPlugin(entry.name, { showSheet: false, alive: () => turn === attempt });
  if (turn !== attempt) return;
  if (!result.ok) {
    if (result.cancelled) return dismissAddingManager();
    return useManagerAdds.setState({ adding: adding(entry, "failed", result.reason) });
  }
  await finishWhenRegistered(entry, turn, false, onReady);
}

export async function turnOnPasswordManager(entry: ManagerLook, onReady: (provider: string) => void) {
  if (!turnOnApprovedPlugin(entry.name)) return addPasswordManager(entry, onReady);
  await finishWhenRegistered(entry, ++attempt, true, onReady);
}

export function dismissAddingManager() {
  attempt += 1;
  useManagerAdds.setState({ adding: null });
}
