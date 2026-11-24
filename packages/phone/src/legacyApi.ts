export type LegacyTab = {
  id: string;
  url: string;
  title: string;
  created: number;
  lastActive: number;
  position: number;
  origin: "typed" | "search" | "link" | "sync" | "share" | "sent";
  archivedAt?: number;
  profileSyncId?: string;
  savedState?: string;
  faviconUrl?: string;
  themeColor?: string;
  snapshotPath?: string;
  receivedKey?: string;
  receivedFromDevice?: string;
};

export type LegacyVisit = {
  url: string;
  title: string;
  visitedAt: number;
  transition: "typed" | "link" | "backForward" | "formSubmit" | "restored" | "other";
  profileSyncId?: string;
};

export type LegacyData = {
  version: 1;
  store: string | null;
  tabs: LegacyTab[];
  selectedTabId: string | null;
  archive: LegacyTab[];
  visits: LegacyVisit[];
  preferences: Record<string, unknown>;
};

export type LegacyCounts = { tabs: number; archive: number; visits: number };

export type LegacyUnusableReason = "schema" | "corrupt" | "locked" | "io";

export type LegacySource =
  | { kind: "none" }
  | { kind: "pending"; counts: LegacyCounts }
  | { kind: "done"; outcome?: "imported" | "startedFresh" }
  | { kind: "unusable"; reason: LegacyUnusableReason };

export type LegacyRead = {
  tabs: LegacyTab[];
  archive: LegacyTab[];
  selectedTabId: string | null;
  preferences: Record<string, string>;
};

export type LegacyVisitPage = { visits: (LegacyVisit & { id: number })[]; next: number | null };

export type LegacyReceipt = { version: 1; tabs: number; archive: number; visits: number; preferences: number };

type OldRead = (Omit<LegacyData, "store" | "selectedTabId"> & { store?: string; selectedTabId?: string }) | null;

export type LegacyNative = {
  source?(): Promise<LegacySource>;
  sourceState?(): Promise<LegacySource>;
  readLegacy?(): Promise<LegacyRead>;
  readVisits?(afterId: number, limit: number): Promise<LegacyVisitPage>;
  applyNativeSettings?(): Promise<void>;
  markImportedWith?(receipt: LegacyReceipt): Promise<void>;
  startFresh?(): Promise<void>;
  labSetUnusable?(on: boolean): void;
  settledState?(): string;
  available?(): Promise<boolean>;
  imported?(): Promise<boolean>;
  markImported?(): Promise<void>;
  read?(): Promise<OldRead>;
};

export function legacyApis(native: LegacyNative | null) {
  const sourceCall = (): (() => Promise<LegacySource>) | null => {
    if (typeof native?.source === "function") return () => native.source!();
    if (typeof native?.sourceState === "function") return () => native.sourceState!();
    return null;
  };

  const usesSourceShape = () => sourceCall() !== null;

  let oldRead: Promise<OldRead> | null = null;

  const readOld = (): Promise<OldRead> => {
    if (oldRead) return oldRead;
    const attempt = native?.read ? native.read() : Promise.resolve(null);
    oldRead = attempt;
    attempt.then(
      (data) => {
        if (!data && oldRead === attempt) oldRead = null;
      },
      () => {
        if (oldRead === attempt) oldRead = null;
      },
    );
    return attempt;
  };

  const asPreferenceStrings = (values: Record<string, unknown>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(values).flatMap(([key, value]) =>
        typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? [[key, String(value)]] : [],
      ),
    );

  const legacyLab = {
    setUnusable: (on: boolean): boolean => {
      if (!native?.labSetUnusable) return false;
      native.labSetUnusable(on);
      return true;
    },
  };

  const legacyImport = {
    source: async (): Promise<LegacySource> => {
      if (!native) return { kind: "none" };
      const source = sourceCall();
      if (source) return source();
      if (native.imported && (await native.imported())) return { kind: "done" };
      if (!native.available || !(await native.available())) return { kind: "none" };
      const data = await readOld();
      if (!data) return { kind: "unusable", reason: "io" };
      return { kind: "pending", counts: { tabs: data.tabs.length, archive: data.archive.length, visits: data.visits.length } };
    },
    read: async (): Promise<LegacyRead> => {
      if (!native) throw new Error("there is no legacy data to read");
      if (usesSourceShape()) return native.readLegacy!();
      const data = await readOld();
      if (!data) throw new Error("the legacy data could not be read");
      return { tabs: data.tabs, archive: data.archive, selectedTabId: data.selectedTabId ?? null, preferences: asPreferenceStrings(data.preferences) };
    },
    readVisits: async (afterId: number, limit: number): Promise<LegacyVisitPage> => {
      if (!native) return { visits: [], next: null };
      if (usesSourceShape()) return native.readVisits!(afterId, limit);
      const data = await readOld();
      if (!data) throw new Error("the legacy data could not be read");
      const start = Math.max(0, afterId);
      const visits = data.visits.slice(start, start + limit).map((visit, index) => ({ ...visit, id: start + index + 1 }));
      const end = start + visits.length;
      return { visits, next: end < data.visits.length ? end : null };
    },
    applyNativeSettings: async (): Promise<void> => {
      if (usesSourceShape()) await native!.applyNativeSettings!();
    },
    startFresh: async (): Promise<void> => {
      if (native?.startFresh) await native.startFresh();
    },
    markImported: async (receipt: LegacyReceipt): Promise<void> => {
      if (!native) return;
      if (usesSourceShape()) {
        await native.markImportedWith!(receipt);
        return;
      }
      await native.markImported?.();
    },
  };

  const legacy = {
    available: async (): Promise<boolean> => {
      const source = await legacyImport.source();
      return source.kind === "pending";
    },
    imported: async (): Promise<boolean> => (await legacyImport.source()).kind !== "pending",
    markImported: async (): Promise<void> => {
      if (usesSourceShape()) throw new Error("use legacyImport.markImported(receipt) on this platform");
      await native?.markImported?.();
    },
    read: async (): Promise<LegacyData | null> => {
      if (usesSourceShape()) return null;
      const data = native ? await readOld() : null;
      return data ? { ...data, store: data.store ?? null, selectedTabId: data.selectedTabId ?? null } : null;
    },
  };

  const legacySettled = (): "none" | "imported" | "startedFresh" | "pending" | null => {
    if (typeof native?.settledState !== "function") return null;
    const state = native.settledState();
    return state === "none" || state === "imported" || state === "startedFresh" ? state : "pending";
  };

  return { legacyImport, legacy, legacyLab, legacySettled };
}
