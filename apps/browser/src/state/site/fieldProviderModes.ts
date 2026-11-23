import { create } from "zustand";
import { useBrowser, type BrowserState } from "../browser/store";
import { engineProfile } from "../browser/model";
import { tabEngine } from "../engines/engines";
import { regularProfileId, type FieldProviderFill } from "./passwordManagerChoice";

type ProviderModes = { modes: Readonly<Record<string, FieldProviderFill>> };

export const useFieldProviderModes = create<ProviderModes>()(() => ({ modes: {} }));

export const modesOf = (providers: readonly { profile: string; fill: FieldProviderFill }[]) => Object.fromEntries(providers.map((p) => [p.profile, p.fill]));

const fillOf = (modes: ProviderModes["modes"], s: BrowserState, tabId: string): FieldProviderFill | null => {
  const tab = s.tabs[tabId];
  const fill = tab ? (modes[engineProfile(s, regularProfileId(tab.profileId))] ?? null) : null;
  return fill === "menu" && tabEngine(s, tabId) !== "chromium" ? null : fill;
};

export const fieldProviderFillOfTab = (tabId: string) => fillOf(useFieldProviderModes.getState().modes, useBrowser.getState(), tabId);

export function useFieldProviderFillOfTab(tabId: string): FieldProviderFill | null {
  const modes = useFieldProviderModes((m) => m.modes);
  return useBrowser((s) => fillOf(modes, s, tabId));
}
