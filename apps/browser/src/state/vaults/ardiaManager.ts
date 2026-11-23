import { refreshProvider } from "./actions";
import { ARDIA_PROVIDER } from "./ardia";
import { vaultsSupported } from "./enabled";
import { loadVaultItems } from "./store";

export async function refreshArdiaManager() {
  if (!vaultsSupported) return;
  await refreshProvider(ARDIA_PROVIDER);
  await loadVaultItems(ARDIA_PROVIDER, true);
}
