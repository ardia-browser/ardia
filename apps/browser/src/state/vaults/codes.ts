import { create } from "zustand";
import { vaultTotp, type VaultItem, type VaultTotp } from "../../platform/vaults";
import { itemKey } from "./originMatch";

export type { VaultTotp };
type VaultCode = VaultTotp | "loading" | "none";

export const useVaultCodes = create<Record<string, VaultCode>>()(() => ({}));

const set = (key: string, code: VaultCode | null) =>
  useVaultCodes.setState((s) => {
    if (code) return { ...s, [key]: code };
    const { [key]: _gone, ...rest } = s;
    return rest;
  }, true);

export function codeAt(code: VaultTotp, now: number): VaultTotp | null {
  if (now < code.expiresAt) return code;
  const periodMs = code.period * 1000;
  if (code.next && now < code.expiresAt + periodMs) return { code: code.next, period: code.period, expiresAt: code.expiresAt + periodMs };
  return null;
}

const fetching = new Map<string, Promise<VaultCode>>();
let generation = 0;

function fetchCode(item: Pick<VaultItem, "provider" | "id">, key: string): Promise<VaultCode> {
  const running = fetching.get(key);
  if (running) return running;
  const asked = generation;
  const fetched = vaultTotp(item.provider, item.id)
    .then(
      (totp): VaultCode => (totp?.code ? totp : "none"),
      (): VaultCode => "none",
    )
    .then((code) => {
      if (asked !== generation) return "none";
      fetching.delete(key);
      const now = useVaultCodes.getState()[key];
      if (now !== undefined && now !== "none") set(key, code);
      return code;
    });
  fetching.set(key, fetched);
  return fetched;
}

export async function loadVaultCode(item: Pick<VaultItem, "provider" | "id">): Promise<VaultCode> {
  const key = itemKey(item);
  const known = useVaultCodes.getState()[key];
  if (known === "none") return known;
  if (known === "loading") return fetching.get(key) ?? known;
  const current = known ? codeAt(known, Date.now()) : null;
  if (current) {
    if (current !== known) {
      set(key, current);
      void fetchCode(item, key);
    }
    return current;
  }
  set(key, "loading");
  return fetchCode(item, key);
}

export const forgetVaultCode = (item: Pick<VaultItem, "provider" | "id">) => set(itemKey(item), null);
export function clearVaultCodes() {
  generation += 1;
  fetching.clear();
  useVaultCodes.setState({}, true);
}
export const prefetchVaultCode = (item: Pick<VaultItem, "provider" | "id">) => void loadVaultCode(item);
