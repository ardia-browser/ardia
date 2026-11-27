import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import type { Me, PresenceEntry, WorkspaceId, WorkspaceInfo } from "../../shared/protocol";
import { allPages, getPage, metaOf, pagesOf, type PageMeta } from "../../shared/model";
import type { NotesClient } from "../client/types";

const treeVersions = new WeakMap<Y.Doc, { version: number; listeners: Set<() => void> }>();

function treeSignal(tree: Y.Doc) {
  let signal = treeVersions.get(tree);
  if (!signal) {
    const created = { version: 0, listeners: new Set<() => void>() };
    signal = created;
    treeVersions.set(tree, created);
    const bump = () => {
      created.version++;
      for (const listener of [...created.listeners]) listener();
    };
    pagesOf(tree).observeDeep(bump);
    metaOf(tree).observe(bump);
  }
  return signal;
}

export function useTreeVersion(tree: Y.Doc | null | undefined): number {
  return useSyncExternalStore(
    (listener) => {
      if (!tree) return () => {};
      const signal = treeSignal(tree);
      signal.listeners.add(listener);
      return () => signal.listeners.delete(listener);
    },
    () => (tree ? treeSignal(tree).version : -1),
  );
}

export function usePageMeta(tree: Y.Doc | null | undefined, id: string | null | undefined): PageMeta | null {
  const version = useTreeVersion(tree);
  return useMemo(() => (tree && id ? getPage(tree, id) : null), [tree, id, version]);
}

export function useAllPages(tree: Y.Doc | null | undefined): PageMeta[] {
  const version = useTreeVersion(tree);
  return useMemo(() => (tree ? allPages(tree) : []), [tree, version]);
}

export function useMe(client: NotesClient): Me {
  return useSyncExternalStore((l) => client.onMe(l), () => client.me());
}

export function useWorkspaces(client: NotesClient): WorkspaceInfo[] {
  return useSyncExternalStore((l) => client.onWorkspaces(l), () => client.workspaces());
}

export function usePresence(client: NotesClient): PresenceEntry[] {
  const [list, setList] = useState(() => client.presence());
  useEffect(() => client.onPresence(setList), [client]);
  return list;
}

export function usePath(client: NotesClient): string {
  return useSyncExternalStore((l) => client.onPath(() => l()), () => client.path());
}

export type Trees = Map<WorkspaceId, Y.Doc>;

export function useTrees(client: NotesClient, workspaces: WorkspaceInfo[]): { trees: Trees; synced: boolean } {
  const handles = useRef(new Map<WorkspaceId, { doc: Y.Doc; release: () => void; synced: boolean }>());
  const [, force] = useState(0);
  const ids = workspaces.filter((w) => w.state === "ready" || w.state === "downloading").map((w) => w.id);
  const key = ids.join(",");
  useEffect(() => {
    const map = handles.current;
    for (const id of ids) {
      if (map.has(id)) continue;
      const opened = client.open(id, "ws");
      const entry = { doc: opened.doc, release: opened.release, synced: false };
      map.set(id, entry);
      void opened.synced.then(() => {
        entry.synced = true;
        force((n) => n + 1);
      });
    }
    for (const [id, entry] of map) {
      if (!ids.includes(id)) {
        entry.release();
        map.delete(id);
      }
    }
    force((n) => n + 1);
  }, [client, key]);
  useEffect(
    () => () => {
      for (const entry of handles.current.values()) entry.release();
      handles.current.clear();
    },
    [],
  );
  const next = new Map<WorkspaceId, Y.Doc>();
  let synced = ids.length > 0;
  for (const id of ids) {
    const entry = handles.current.get(id);
    if (entry?.synced) next.set(id, entry.doc);
    else synced = false;
  }
  const signature = [...next.keys()].join(",");
  const stable = useRef<{ signature: string; trees: Map<WorkspaceId, Y.Doc> }>({ signature: "", trees: next });
  if (stable.current.signature !== signature || [...next].some(([id, doc]) => stable.current.trees.get(id) !== doc)) stable.current = { signature, trees: next };
  return { trees: stable.current.trees, synced };
}

const NARROW = "(max-width: 680px)";

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia === "function" && matchMedia(NARROW).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(NARROW);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function useStored<T>(key: string, initial: T): [T, (value: T | ((old: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`notes:${key}`);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = (next: T | ((old: T) => T)) =>
    setValue((old) => {
      const resolved = typeof next === "function" ? (next as (o: T) => T)(old) : next;
      try {
        localStorage.setItem(`notes:${key}`, JSON.stringify(resolved));
      } catch {}
      return resolved;
    });
  return [value, set];
}

export function useWindowStored(key: string, initial: string): [string, (value: string) => void] {
  const [value, setValue] = useState<string>(() => {
    for (const store of [() => sessionStorage, () => localStorage]) {
      try {
        const raw = store().getItem(`notes:${key}`);
        if (raw !== null) return JSON.parse(raw) as string;
      } catch {}
    }
    return initial;
  });
  const set = (next: string) => {
    for (const store of [() => sessionStorage, () => localStorage]) {
      try {
        store().setItem(`notes:${key}`, JSON.stringify(next));
      } catch {}
    }
    setValue(next);
  };
  return [value, set];
}

export function relativeTime(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(at).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useTreesVersion(trees: Map<string, Y.Doc>): string {
  return useSyncExternalStore(
    (listener) => {
      const offs = [...trees.values()].map((tree) => {
        const signal = treeSignal(tree);
        signal.listeners.add(listener);
        return () => signal.listeners.delete(listener);
      });
      return () => offs.forEach((off) => off());
    },
    () => [...trees.values()].map((tree) => treeSignal(tree).version).join(","),
  );
}
