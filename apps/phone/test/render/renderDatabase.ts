import type { SqlDatabase, SqlValue } from "../../src/lib/sqlDatabase";

type NodeSqlite = { DatabaseSync: new (path: string) => NodeDatabase };
type NodeStatement = { run(...values: SqlValue[]): unknown; all(...values: SqlValue[]): unknown[]; get(...values: SqlValue[]): unknown };
type NodeDatabase = { exec(sql: string): void; prepare(sql: string): NodeStatement; isTransaction: boolean };

export function renderDatabase(): SqlDatabase {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as NodeSqlite;
  const db = new DatabaseSync(":memory:");
  const args = (values: readonly SqlValue[] | undefined) => [...(values ?? [])];
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, values) => void db.prepare(sql).run(...args(values)),
    all: <T,>(sql: string, values?: readonly SqlValue[]) => db.prepare(sql).all(...args(values)) as T[],
    first: <T,>(sql: string, values?: readonly SqlValue[]) => (db.prepare(sql).get(...args(values)) as T | undefined) ?? null,
    transaction: (work) => {
      db.exec("BEGIN");
      try {
        work();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    inTransaction: () => db.isTransaction,
  };
}
