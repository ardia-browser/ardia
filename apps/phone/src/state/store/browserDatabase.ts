import { TAB_ORIGINS, type BrowserTab, type TabOrigin } from "../tabs/tabModels.ts";
import type { SqlDatabase, SqlValue } from "../../lib/sqlDatabase.ts";

export type VisitTransition = "typed" | "link" | "backForward" | "formSubmit" | "restored" | "other";

export type Visit = { id: number; url: string; title: string; visitedAt: number; profileSyncId: string | null; transition: VisitTransition };

const TAB_COLUMNS =
  "id, url, title, created, lastActive, archivedAt, position, profileSyncId, faviconUrl, themeColorHex, snapshotFileName, origin, receivedKey, receivedFromDevice, pinnedKey";

const VISIT_COLUMNS = "id, url, title, visitedAt, profileSyncId, transition";

type TabRow = Omit<BrowserTab, "isPrivate" | "origin"> & { origin: string };

const originOf = (raw: string): TabOrigin => (TAB_ORIGINS as readonly string[]).includes(raw) ? (raw as TabOrigin) : "typed";

const tabOf = (row: TabRow): BrowserTab => ({ ...row, origin: originOf(row.origin), isPrivate: false });

const tabValues = (tab: BrowserTab): SqlValue[] => [
  tab.id,
  tab.url,
  tab.title,
  tab.created,
  tab.lastActive,
  tab.archivedAt,
  tab.position,
  tab.profileSyncId,
  tab.faviconUrl,
  tab.themeColorHex,
  tab.snapshotFileName,
  tab.origin,
  tab.receivedKey,
  tab.receivedFromDevice,
  tab.pinnedKey,
];

const escapeLike = (text: string) => `%${text.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;

export const readOpenTabs = (db: SqlDatabase) =>
  db.all<TabRow>(`SELECT ${TAB_COLUMNS} FROM tabs WHERE archivedAt IS NULL ORDER BY position`).map(tabOf);

export const readArchivedTabs = (db: SqlDatabase, limit: number, offset = 0) =>
  db.all<TabRow>(`SELECT ${TAB_COLUMNS} FROM tabs WHERE archivedAt IS NOT NULL ORDER BY archivedAt DESC LIMIT ? OFFSET ?`, [limit, offset]).map(tabOf);

export const readArchivedTab = (db: SqlDatabase, id: string) => {
  const row = db.first<TabRow>(`SELECT ${TAB_COLUMNS} FROM tabs WHERE id = ? AND archivedAt IS NOT NULL`, [id]);
  return row ? tabOf(row) : null;
};

export const searchArchivedTabs = (db: SqlDatabase, text: string, limit: number) => {
  const pattern = escapeLike(text);
  return db
    .all<TabRow>(
      `SELECT ${TAB_COLUMNS} FROM tabs WHERE archivedAt IS NOT NULL AND (title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\') ORDER BY archivedAt DESC LIMIT ?`,
      [pattern, pattern, limit],
    )
    .map(tabOf);
};

export const countArchivedTabs = (db: SqlDatabase) => db.first<{ n: number }>("SELECT count(*) AS n FROM tabs WHERE archivedAt IS NOT NULL")?.n ?? 0;

export function writeTabs(db: SqlDatabase, put: readonly BrowserTab[], remove: readonly string[]) {
  const stored = put.filter((tab) => !tab.isPrivate);
  if (!stored.length && !remove.length) return;
  db.transaction(() => {
    for (const tab of stored) db.run(`INSERT OR REPLACE INTO tabs (${TAB_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, tabValues(tab));
    for (const id of remove) {
      db.run("DELETE FROM tabs WHERE id = ?", [id]);
      db.run("DELETE FROM tab_state WHERE id = ?", [id]);
    }
  });
}

const ID_CHUNK = 500;

export function archivedIdsAmong(db: SqlDatabase, ids: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (let start = 0; start < ids.length; start += ID_CHUNK) {
    const chunk = ids.slice(start, start + ID_CHUNK);
    const marks = chunk.map(() => "?").join(",");
    for (const row of db.all<{ id: string }>(`SELECT id FROM tabs WHERE archivedAt IS NOT NULL AND id IN (${marks})`, chunk)) found.add(row.id);
  }
  return found;
}

export type TabCommit = { clearArchived: boolean; put: readonly BrowserTab[]; remove: readonly string[]; states?: readonly (readonly [string, string | null])[] };

export function commitTabChanges(db: SqlDatabase, commit: TabCommit): string[] {
  const stored = commit.put.filter((tab) => !tab.isPrivate);
  let cleared: string[] = [];
  const states = commit.states ?? [];
  if (!commit.clearArchived && !stored.length && !commit.remove.length && !states.length) return cleared;
  const kept = new Set(stored.map((tab) => tab.id));
  db.transaction(() => {
    if (commit.clearArchived) {
      cleared = db.all<{ id: string }>("SELECT id FROM tabs WHERE archivedAt IS NOT NULL").map((r) => r.id).filter((id) => !kept.has(id));
      for (let start = 0; start < cleared.length; start += ID_CHUNK) {
        const chunk = cleared.slice(start, start + ID_CHUNK);
        const marks = chunk.map(() => "?").join(",");
        db.run(`DELETE FROM tab_state WHERE id IN (${marks})`, chunk);
        db.run(`DELETE FROM tabs WHERE id IN (${marks})`, chunk);
      }
    }
    for (const tab of stored) db.run(`INSERT OR REPLACE INTO tabs (${TAB_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, tabValues(tab));
    for (const id of commit.remove) {
      db.run("DELETE FROM tabs WHERE id = ?", [id]);
      db.run("DELETE FROM tab_state WHERE id = ?", [id]);
    }
    for (const [id, data] of states) {
      if (data === null) db.run("DELETE FROM tab_state WHERE id = ?", [id]);
      else db.run("INSERT OR REPLACE INTO tab_state (id, data) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM tabs WHERE id = ?)", [id, data, id]);
    }
  });
  return cleared;
}

export function deleteArchivedTabs(db: SqlDatabase): string[] {
  let removed: string[] = [];
  db.transaction(() => {
    removed = db.all<{ id: string }>("SELECT id FROM tabs WHERE archivedAt IS NOT NULL").map((r) => r.id);
    db.run("DELETE FROM tab_state WHERE id IN (SELECT id FROM tabs WHERE archivedAt IS NOT NULL)");
    db.run("DELETE FROM tabs WHERE archivedAt IS NOT NULL");
  });
  return removed;
}

export const archivedBefore = (db: SqlDatabase, cutoff: number): string[] =>
  db.all<{ id: string }>("SELECT id FROM tabs WHERE archivedAt IS NOT NULL AND archivedAt < ?", [cutoff]).map((r) => r.id);

export const archivedRankedFrom = (db: SqlDatabase, offset: number) =>
  db.all<TabRow>(`SELECT ${TAB_COLUMNS} FROM tabs WHERE archivedAt IS NOT NULL ORDER BY archivedAt DESC LIMIT -1 OFFSET ?`, [offset]).map(tabOf);

export function expiredArchivedIds(db: SqlDatabase, cutoff: number, keep: number): string[] {
  const old = db.all<{ id: string }>("SELECT id FROM tabs WHERE archivedAt IS NOT NULL AND archivedAt < ?", [cutoff]);
  const beyond = db.all<{ id: string }>("SELECT id FROM tabs WHERE archivedAt IS NOT NULL ORDER BY archivedAt DESC LIMIT -1 OFFSET ?", [keep]);
  return [...new Set([...old, ...beyond].map((r) => r.id))];
}

export const readTabState = (db: SqlDatabase, id: string) => db.first<{ data: string }>("SELECT data FROM tab_state WHERE id = ?", [id])?.data ?? null;

export const writeTabState = (db: SqlDatabase, id: string, data: string | null) =>
  data === null ? db.run("DELETE FROM tab_state WHERE id = ?", [id]) : db.run("INSERT OR REPLACE INTO tab_state (id, data) VALUES (?, ?)", [id, data]);

export const maxVisitId = (db: SqlDatabase) => db.first<{ n: number | null }>("SELECT max(id) AS n FROM visits")?.n ?? 0;

export const insertVisit = (db: SqlDatabase, visit: Visit) =>
  db.run(`INSERT OR REPLACE INTO visits (${VISIT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`, [
    visit.id,
    visit.url,
    visit.title,
    visit.visitedAt,
    visit.profileSyncId,
    visit.transition,
  ]);

export const updateVisit = (db: SqlDatabase, visit: Visit) =>
  db.run("UPDATE visits SET url = ?, title = ? WHERE id = ?", [visit.url, visit.title, visit.id]);

export const newestVisits = (db: SqlDatabase, limit: number) =>
  db.all<Visit>(`SELECT ${VISIT_COLUMNS} FROM visits ORDER BY visitedAt DESC, id DESC LIMIT ?`, [limit]);

export const searchVisits = (db: SqlDatabase, text: string, limit: number) => {
  const pattern = escapeLike(text);
  return db.all<Visit>(
    `SELECT ${VISIT_COLUMNS} FROM visits WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' ORDER BY visitedAt DESC, id DESC LIMIT ?`,
    [pattern, pattern, limit],
  );
};

export const deleteVisitsBefore = (db: SqlDatabase, cutoff: number) => db.run("DELETE FROM visits WHERE visitedAt < ?", [cutoff]);

export const deleteVisitsSince = (db: SqlDatabase, since: number | null) =>
  since === null ? db.run("DELETE FROM visits") : db.run("DELETE FROM visits WHERE visitedAt >= ?", [since]);

export function knownReceivedKeys(db: SqlDatabase, keys: readonly string[]): Set<string> {
  if (!keys.length) return new Set();
  const marks = keys.map(() => "?").join(",");
  return new Set(db.all<{ receivedKey: string }>(`SELECT receivedKey FROM tabs WHERE receivedKey IN (${marks})`, [...keys]).map((row) => row.receivedKey));
}

export function deleteVisitsFor(db: SqlDatabase, urls: readonly string[], profileSyncId: string | null) {
  if (!urls.length) return;
  const marks = urls.map(() => "?").join(",");
  if (profileSyncId === null) db.run(`DELETE FROM visits WHERE url IN (${marks}) AND profileSyncId IS NULL`, [...urls]);
  else db.run(`DELETE FROM visits WHERE url IN (${marks}) AND profileSyncId = ?`, [...urls, profileSyncId]);
}

export type ImportRows = {
  tabs: readonly BrowserTab[];
  states: readonly { id: string; data: string }[];
  visits: readonly Omit<Visit, "id">[];
  preferences: Readonly<Record<string, string>>;
};

export class ImportMismatch extends Error {}

export function writeImport(db: SqlDatabase, rows: ImportRows, markerKey: string, marker: string) {
  db.transaction(() => {
    for (const tab of rows.tabs) db.run(`INSERT INTO tabs (${TAB_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, tabValues(tab));
    for (const state of rows.states) db.run("INSERT OR REPLACE INTO tab_state (id, data) VALUES (?, ?)", [state.id, state.data]);
    let id = maxVisitId(db);
    for (const visit of rows.visits) {
      id += 1;
      db.run(`INSERT INTO visits (${VISIT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`, [id, visit.url, visit.title, visit.visitedAt, visit.profileSyncId, visit.transition]);
    }
    for (const [key, value] of Object.entries(rows.preferences)) db.run("INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)", [key, value]);
    const tabs = db.first<{ n: number }>("SELECT count(*) AS n FROM tabs")?.n ?? 0;
    const visits = db.first<{ n: number }>("SELECT count(*) AS n FROM visits")?.n ?? 0;
    const states = db.first<{ n: number }>("SELECT count(*) AS n FROM tab_state")?.n ?? 0;
    if (tabs !== rows.tabs.length || visits !== rows.visits.length || states !== rows.states.length) {
      throw new ImportMismatch(`tabs ${tabs}/${rows.tabs.length} visits ${visits}/${rows.visits.length} states ${states}/${rows.states.length}`);
    }
    db.run("INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)", [markerKey, marker]);
  });
}

export class TransactionLost extends Error {}

export async function asyncTransaction(db: SqlDatabase, work: () => Promise<void>) {
  db.exec("BEGIN IMMEDIATE");
  try {
    await work();
    if (!db.inTransaction()) throw new TransactionLost();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

export function existingTabIds(db: SqlDatabase, ids: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    const marks = chunk.map(() => "?").join(",");
    for (const row of db.all<{ id: string }>(`SELECT id FROM tabs WHERE id IN (${marks})`, chunk)) found.add(row.id);
  }
  return found;
}

export function bringOpenTabToFront(db: SqlDatabase, id: string) {
  const newest = db.first<{ n: number | null }>("SELECT max(lastActive) AS n FROM tabs WHERE archivedAt IS NULL AND id != ?", [id])?.n ?? null;
  if (newest !== null) db.run("UPDATE tabs SET lastActive = ? WHERE id = ? AND archivedAt IS NULL AND lastActive <= ?", [newest + 1, id, newest]);
}

export const insertNewTab = (db: SqlDatabase, tab: BrowserTab) =>
  db.run(`INSERT INTO tabs (${TAB_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, tabValues(tab));

export const countTabStates = (db: SqlDatabase, ids: readonly string[]) => {
  let n = 0;
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    n += db.first<{ n: number }>(`SELECT count(*) AS n FROM tab_state WHERE id IN (${chunk.map(() => "?").join(",")})`, chunk)?.n ?? 0;
  }
  return n;
};

export const countVisits = (db: SqlDatabase) => db.first<{ n: number }>("SELECT count(*) AS n FROM visits")?.n ?? 0;

export function readPreferences(db: SqlDatabase): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of db.all<{ key: string; value: string }>("SELECT key, value FROM preferences")) out[row.key] = row.value;
  return out;
}

export function writePreference(db: SqlDatabase, key: string, value: string | null) {
  if (value === null) db.run("DELETE FROM preferences WHERE key = ?", [key]);
  else db.run("INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)", [key, value]);
}
