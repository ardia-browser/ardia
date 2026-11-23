import { useEffect, useState } from "react";
import { vaultItemPage, type VaultItem } from "../../platform/vaults";
import { useVaults } from "./store";

export const ITEM_PAGE_MOST = 1000;

export type ManagerPage = { total: number; items: readonly VaultItem[] };

const EMPTY: ManagerPage = { total: 0, items: [] };

export function pageRequests(loaded: number, wanted: number): { offset: number; limit: number }[] {
  const asks: { offset: number; limit: number }[] = [];
  for (let offset = loaded; offset < wanted; offset += ITEM_PAGE_MOST) asks.push({ offset, limit: Math.min(ITEM_PAGE_MOST, wanted - offset) });
  return asks;
}

export async function fetchManagerRows(query: string, from: ManagerPage, wanted: number): Promise<ManagerPage> {
  let page = from;
  for (const { offset, limit } of pageRequests(from.items.length, Math.min(wanted, from.items.length ? from.total : wanted))) {
    const answer = await vaultItemPage({ query, offset, limit, managersOnly: true, profile: null });
    page = { total: answer.total, items: [...page.items, ...answer.items] };
    if (answer.items.length < limit) break;
  }
  return page;
}

export function useManagerRows(enabled: boolean, query: string, wanted: number): ManagerPage & { ready: boolean } {
  const stamp = useVaults((s) => s.itemsStamp);
  const listed = useVaults((s) => s.listed.join(" "));
  const [state, setState] = useState<{ key: string; page: ManagerPage; ready: boolean }>({ key: "", page: EMPTY, ready: false });
  const key = `${enabled}\n${query}\n${stamp}\n${listed}`;
  const current = state.key === key ? state : { key, page: EMPTY, ready: false };
  useEffect(() => {
    if (!enabled) return setState({ key, page: EMPTY, ready: true });
    if (current.ready && current.page.items.length >= Math.min(wanted, current.page.total)) return;
    let live = true;
    void fetchManagerRows(query, current.page, Math.max(wanted, 1)).then(
      (page) => live && setState({ key, page, ready: true }),
      () => live && setState({ key, page: current.page, ready: true }),
    );
    return () => {
      live = false;
    };
  }, [key, wanted]);
  return { ...current.page, ready: current.ready };
}

export function useManagerTotal(enabled: boolean): number {
  const stamp = useVaults((s) => s.itemsStamp);
  const listed = useVaults((s) => s.listed.join(" "));
  const [total, setTotal] = useState(0);
  useEffect(() => {
    if (!enabled) return setTotal(0);
    let live = true;
    void vaultItemPage({ query: "", offset: 0, limit: 0, managersOnly: true, profile: null }).then(
      (page) => live && setTotal(page.total),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [enabled, stamp, listed]);
  return total;
}
