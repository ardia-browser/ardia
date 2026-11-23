import { create } from "zustand";
import * as official from "../plugins/official";
import { useVaults, vaultProviderOf } from "./store";

export type CatalogueState = "available" | "installed" | "unsupported";
export type CatalogueEntry = { name: string; title: string; blurb: string; icon: string; accent?: string; state: CatalogueState };

type CatalogueHook = () => CatalogueEntry[];

const NONE: CatalogueEntry[] = [];
const sdkCatalogue = (official as { useOfficialCredentialProviders?: CatalogueHook }).useOfficialCredentialProviders ?? (() => NONE);

export type AddPhase = "installing" | "starting" | "failed";
export type AddingManager = { name: string; title: string; icon: string; accent?: string; phase: AddPhase; reason: string };

export const useManagerAdds = create<{ adding: AddingManager | null; preview: CatalogueEntry[] | null }>()(() => ({ adding: null, preview: null }));

export const showPreviewCatalogue = (entries: CatalogueEntry[] | null) => useManagerAdds.setState({ preview: entries });
export const showPreviewAdding = (adding: AddingManager | null) => useManagerAdds.setState({ adding });

export function useManagerCatalogue(): CatalogueEntry[] {
  const fromSdk = sdkCatalogue();
  const preview = useManagerAdds((s) => s.preview);
  const registered = useVaults((s) => s.providers.map((p) => p.id).join(" "));
  const shown = registered ? new Set(registered.split(" ")) : new Set<string>();
  return (preview ?? fromSdk).filter((e) => e.state !== "unsupported" && !shown.has(e.name));
}

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

export async function addPasswordManager(entry: Pick<CatalogueEntry, "name" | "title" | "icon" | "accent">, onReady: (provider: string) => void) {
  const turn = ++attempt;
  useManagerAdds.setState({ adding: { name: entry.name, title: entry.title, icon: entry.icon, accent: entry.accent, phase: "installing", reason: "" } });
  const result = await official.installOfficialPlugin(entry.name, { showSheet: false, alive: () => turn === attempt });
  if (turn !== attempt) return;
  if (!result.ok) {
    if (result.cancelled) return dismissAddingManager();
    return useManagerAdds.setState({ adding: { name: entry.name, title: entry.title, icon: entry.icon, accent: entry.accent, phase: "failed", reason: result.reason } });
  }
  useManagerAdds.setState({ adding: { name: entry.name, title: entry.title, icon: entry.icon, accent: entry.accent, phase: "starting", reason: "" } });
  if (!(await waitForProvider(entry.name, turn))) return;
  dismissAddingManager();
  const state = vaultProviderOf(entry.name)?.state;
  if (state !== "unlocked" && state !== "locked") onReady(entry.name);
}

export function dismissAddingManager() {
  attempt += 1;
  useManagerAdds.setState({ adding: null });
}
