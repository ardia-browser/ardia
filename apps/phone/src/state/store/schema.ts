import type { SqlDatabase } from "../../lib/sqlDatabase.ts";
import { t } from "../../lib/uiLanguage";


export const DATABASE_FILE = "browser.db";

export const SCHEMA_VERSION = 2;

const MIGRATIONS: Record<number, string[]> = {
  0: [
    t(`CREATE TABLE tabs (id TEXT PRIMARY KEY NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, created INTEGER NOT NULL, `) +
      t(`lastActive INTEGER NOT NULL, archivedAt INTEGER, position REAL NOT NULL, profileSyncId TEXT, faviconUrl TEXT, `) +
      t(`themeColorHex TEXT, snapshotFileName TEXT, origin TEXT NOT NULL, receivedKey TEXT, receivedFromDevice TEXT)`),
    t(`CREATE INDEX tabs_archivedAt ON tabs(archivedAt)`),
    t(`CREATE INDEX tabs_receivedKey ON tabs(receivedKey) WHERE receivedKey IS NOT NULL`),
    t(`CREATE TABLE tab_state (id TEXT PRIMARY KEY NOT NULL, data BLOB NOT NULL)`),
    t(`CREATE TABLE visits (id INTEGER PRIMARY KEY NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, visitedAt INTEGER NOT NULL, `) +
      t(`profileSyncId TEXT, transition TEXT NOT NULL)`),
    t(`CREATE INDEX visits_url ON visits(url)`),
    t(`CREATE INDEX visits_visitedAt ON visits(visitedAt)`),
    t(`CREATE INDEX visits_profile_visitedAt ON visits(profileSyncId, visitedAt)`),
    t(`CREATE TABLE preferences (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`),
  ],
  1: [t(`ALTER TABLE tabs ADD COLUMN pinnedKey TEXT`)],
};

export type MigrationResult = { from: number; to: number } | { refused: number };

export function migrate(db: SqlDatabase): MigrationResult {
  const from = db.first<{ user_version: number }>(t(`PRAGMA user_version`))?.user_version ?? 0;
  if (from > SCHEMA_VERSION) return { refused: from };
  if (from === SCHEMA_VERSION) return { from, to: from };
  db.transaction(() => {
    for (let version = from; version < SCHEMA_VERSION; version++) {
      for (const statement of MIGRATIONS[version] ?? []) db.exec(statement);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
  return { from, to: SCHEMA_VERSION };
}
