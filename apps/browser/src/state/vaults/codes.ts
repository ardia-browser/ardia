import { create } from "zustand";
import { vaultCodesFor, vaultTotp, type VaultItem, type VaultTotp } from "../../platform/vaults";
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
const priming = new Map<string, Promise<void>>();
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
  const primed = priming.get(key);
  if (primed) await primed;
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

const PRIMED_AT_MOST = 500;

const wantsCode = (key: string, now: number) => {
  const known = useVaultCodes.getState()[key];
  return known === undefined || known === "loading" || (typeof known === "object" && !codeAt(known, now));
};

export function primeVaultCodes(items: readonly Pick<VaultItem, "provider" | "id" | "hasTotp">[]): Promise<void> {
  const now = Date.now();
  const wanted = items.filter((item) => item.hasTotp !== false && wantsCode(itemKey(item), now)).slice(0, PRIMED_AT_MOST);
  if (!wanted.length) return Promise.resolve();
  const asked = generation;
  const keys = wanted.map(itemKey);
  const answered = vaultCodesFor(wanted.map((item) => ({ provider: item.provider, id: item.id }))).then(
    ({ codes, none }) => {
      if (asked !== generation) return;
      const found = Object.entries(codes).filter(([key]) => wantsCode(key, Date.now()));
      const missing = none.filter((key) => useVaultCodes.getState()[key] === undefined);
      if (!found.length && !missing.length) return;
      useVaultCodes.setState((s) => {
        const next: Record<string, VaultCode> = { ...s };
        for (const [key, code] of found) next[key] = code;
        for (const key of missing) next[key] = "none";
        return next;
      }, true);
    },
    () => undefined,
  );
  const settled = answered.finally(() => {
    for (const key of keys) if (priming.get(key) === settled) priming.delete(key);
  });
  for (const key of keys) priming.set(key, settled);
  return settled;
}

export function prefetchVaultCodes(items: readonly Pick<VaultItem, "provider" | "id" | "hasTotp">[]) {
  void primeVaultCodes(items);
  for (const item of items) void loadVaultCode(item);
}

export function refreshWarmedCodes(provider: string) {
  const loading = Object.entries(useVaultCodes.getState()).filter(([key, code]) => code === "loading" && key.startsWith(`${provider}/`));
  if (loading.length) void primeVaultCodes(loading.map(([key]) => ({ provider, id: key.slice(provider.length + 1) })));
}

export const forgetVaultCode = (item: Pick<VaultItem, "provider" | "id">) => set(itemKey(item), null);
export function clearVaultCodes() {
  generation += 1;
  fetching.clear();
  priming.clear();
  useVaultCodes.setState({}, true);
}
export const prefetchVaultCode = (item: Pick<VaultItem, "provider" | "id">) => void loadVaultCode(item);
