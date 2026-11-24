import { useEffect, useMemo, useReducer, useRef } from "react";
import { vaultPaneRows, vaultSavedOn, type VaultPaneRow } from "../../platform/vaults";
import type { SavedPassword } from "../site/passwords";
import { useVaults } from "./store";

export const PANE_PAGE = 100;
export const PANE_PAGES_KEPT = 40;

export type { VaultPaneRow };

export type PaneRows = {
  key: string;
  total: number;
  listed: number;
  ready: boolean;
  rowAt: (index: number) => VaultPaneRow | undefined;
  want: (from: number, to: number) => void;
};

export type PaneRowsArgs = { enabled: boolean; profile: string; query: string; managers: boolean; reload: number };

type Pages = {
  key: string;
  revision: string | null;
  total: number;
  listed: number;
  ready: boolean;
  pages: Map<number, readonly VaultPaneRow[]>;
  asked: Set<number>;
  shownAt: number | null;
  version: number;
};

const fresh = (key: string): Pages => ({ key, revision: null, total: 0, listed: 0, ready: false, pages: new Map(), asked: new Set(), shownAt: null, version: 0 });

export function pagesFor(from: number, to: number): number[] {
  if (to < from) return [];
  const first = Math.floor(Math.max(0, from) / PANE_PAGE);
  const last = Math.floor(Math.max(0, to) / PANE_PAGE);
  const out: number[] = [];
  for (let page = first; page <= last; page++) out.push(page);
  return out;
}

function keepNear(pages: Map<number, readonly VaultPaneRow[]>, around: number) {
  if (pages.size <= PANE_PAGES_KEPT) return;
  const far = [...pages.keys()].sort((a, b) => Math.abs(b - around) - Math.abs(a - around));
  for (const page of far.slice(0, pages.size - PANE_PAGES_KEPT)) pages.delete(page);
}

export function usePaneRows({ enabled, profile, query, managers, reload }: PaneRowsArgs, onFirst?: (listed: number, ms: number) => void): PaneRows {
  const stamp = useVaults((s) => (managers ? s.itemsStamp : 0));
  const listedIds = useVaults((s) => (managers ? s.listed.join(" ") : ""));
  const key = `${enabled}\n${profile}\n${managers}\n${stamp}\n${listedIds}\n${reload}\n${query}`;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const state = useRef<Pages>(fresh(""));
  const reloadSeen = useRef<number | null>(null);
  const firstShown = useRef(onFirst);
  firstShown.current = onFirst;
  if (state.current.key !== key) state.current = fresh(key);

  const ask = (page: number) => {
    const current = state.current;
    if (!enabled || current.asked.has(page) || current.pages.has(page)) return;
    current.asked.add(page);
    const reloading = reloadSeen.current !== reload;
    if (reloading) reloadSeen.current = reload;
    const askedAt = performance.now();
    void vaultPaneRows({ profile, query, offset: page * PANE_PAGE, limit: PANE_PAGE, managers, reload: reloading }).then(
      (answer) => {
        if (state.current !== current) return;
        current.asked.delete(page);
        if (answer.cancelled) return;
        if (current.revision !== null && current.revision !== answer.revision) {
          current.pages.clear();
          current.asked.clear();
        }
        current.revision = answer.revision;
        current.total = answer.total;
        current.listed = answer.listed;
        current.pages.set(page, answer.rows);
        keepNear(current.pages, page);
        if (!current.ready) {
          current.ready = true;
          if (current.shownAt === null) {
            current.shownAt = performance.now();
            firstShown.current?.(answer.listed, current.shownAt - askedAt);
          }
        }
        current.version++;
        bump();
      },
      () => {
        if (state.current !== current) return;
        current.asked.delete(page);
        if (current.ready) return;
        current.ready = true;
        current.version++;
        bump();
      },
    );
  };

  useEffect(() => {
    if (!enabled) {
      state.current.ready = true;
      state.current.version++;
      bump();
      return;
    }
    ask(0);
  }, [key]);

  const lastReady = useRef<Pages | null>(null);
  if (state.current.ready) lastReady.current = state.current;
  const snapshot = !state.current.ready && enabled && lastReady.current ? lastReady.current : state.current;
  return useMemo<PaneRows>(
    () => ({
      key: snapshot.key,
      total: snapshot.total,
      listed: snapshot.listed,
      ready: snapshot.ready,
      rowAt: (index) => snapshot.pages.get(Math.floor(index / PANE_PAGE))?.[index % PANE_PAGE],
      want: (from, to) => {
        for (const page of pagesFor(from, Math.min(to, snapshot.total - 1))) ask(page);
      },
    }),
    [snapshot, snapshot.version],
  );
}

export const savedLoginsOn = (profile: string, origin: string): Promise<readonly SavedPassword[]> => vaultSavedOn(profile, origin);
