import { warmVaults } from "../../platform/vaults";
import { useBrowser } from "../browser/store";
import { isSecureOrigin } from "./originMatch";
import { useVaults } from "./store";
import { anyProfileOnArdia, vaultsOnForTab } from "./enabled";

const loginSites = new Map<string, string>();

const unlockedIds = (providers: readonly { id: string; state: string }[]) => new Set(providers.filter((p) => p.state === "unlocked").map((p) => p.id));

function warmVaultSite(origin: string) {
  if (!anyProfileOnArdia() || !isSecureOrigin(origin) || !unlockedIds(useVaults.getState().providers).size) return;
  void warmVaults(origin).catch(() => undefined);
}

export function noteVaultLoginPage(tabId: string, page: { origin: string; main: boolean }) {
  if (!isSecureOrigin(page.origin) || !vaultsOnForTab(tabId)) return;
  if (page.main) loginSites.set(tabId, page.origin);
  warmVaultSite(page.origin);
}

const knownLoginSites = () => [...new Set(loginSites.values())];

export function startVaultWarming() {
  const stopVaults = useVaults.subscribe((s, prev) => {
    if (s.providers === prev.providers && s.listed === prev.listed && s.itemsStamp === prev.itemsStamp) return;
    const before = unlockedIds(prev.providers);
    const listedNow = s.listed.some((id) => !prev.listed.includes(id)) || (s.itemsStamp !== prev.itemsStamp && s.listed.length > 0);
    const opened = [...unlockedIds(s.providers)].some((id) => !before.has(id));
    if (opened || listedNow) for (const origin of knownLoginSites()) warmVaultSite(origin);
  });
  const stopTabs = useBrowser.subscribeTo(["tabs"], (s, prev) => {
    if (s.tabs === prev.tabs) return;
    for (const tabId of loginSites.keys()) if (!s.tabs[tabId]) loginSites.delete(tabId);
  });
  return () => {
    stopVaults();
    stopTabs();
  };
}
