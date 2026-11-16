import type { Shortcut } from "../commands/shortcuts";
import { storeAction, useBrowser } from "../browser/store";
import { tabLayoutOf } from "../browser/model";
import { steppedInterfaceScale } from "../../lib/interfaceScale";
import { setWeb3Rpcs } from "../../platform/web3";
import { web3RpcProblem } from "./web3Rpcs";

export const updateSettings = storeAction("updateSettings");
export const setSearchEngine = storeAction("setSearchEngine");
export const addCustomEngine = storeAction("addCustomEngine");
export const updateCustomEngine = storeAction("updateCustomEngine");
export const removeCustomEngine = storeAction("removeCustomEngine");

export function setShortcutOverride(id: string, combo: Shortcut | null) {
  const next = { ...useBrowser.getState().settings.shortcuts };
  if (combo) next[id] = [combo.key, ...combo.modifiers];
  else delete next[id];
  useBrowser.getState().updateSettings({ shortcuts: next });
}

export function setWeb3Rpc(chain: string, url: string) {
  useBrowser.getState().updateSettings({ web3Rpcs: { ...useBrowser.getState().settings.web3Rpcs, [chain]: url } });
}

export async function addWeb3Rpc(chain: string, url: string): Promise<string | null> {
  const problem = web3RpcProblem(chain, url);
  if (problem) return problem;
  const current = useBrowser.getState().settings.web3Rpcs;
  const { refused } = await setWeb3Rpcs({ ...current, [chain]: url });
  if (refused.includes(chain)) {
    void setWeb3Rpcs(current);
    return "Ardia can't use this URL. Check the host and the port.";
  }
  setWeb3Rpc(chain, url);
  return null;
}

export function removeWeb3Rpc(chain: string) {
  const next = { ...useBrowser.getState().settings.web3Rpcs };
  delete next[chain];
  useBrowser.getState().updateSettings({ web3Rpcs: next });
}

export function chooseTabLayout(layout: "sidebar" | "top") {
  useBrowser.getState().updateSettings({ tabLayout: layout });
  for (const id of Object.keys(useBrowser.getState().windows)) {
    if (tabLayoutOf(useBrowser.getState(), id) !== layout) useBrowser.getState().toggleTabLayout(id);
  }
}

export function chooseSidebarSide(side: "left" | "right") {
  useBrowser.getState().updateSettings({ sidebarSide: side });
}

export function toggleSidebarSide() {
  chooseSidebarSide(useBrowser.getState().settings.sidebarSide === "right" ? "left" : "right");
}

export function chooseInterfaceScale(scale: number) {
  useBrowser.getState().updateSettings({ interfaceScale: steppedInterfaceScale(scale) });
}
