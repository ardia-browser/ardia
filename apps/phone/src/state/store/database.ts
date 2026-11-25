import type { SqlDatabase } from "../../lib/sqlDatabase";
import { openMemoryDatabase, openSqlDatabase, WAL_SAFE_COMMITS } from "../../platform/database";
import { newUuid } from "../../lib/ids";
import { demoSeed } from "../app/demoSeed";
import { isDemoSession, launchArguments } from "../app/launchFlags";
import { writeImport } from "./browserDatabase";
import { DATABASE_FILE, migrate } from "./schema";

const DEMO_MARKER = "demo.seeded";

let opened: SqlDatabase | null = null;
let demo: SqlDatabase | null = null;
let tabs: SqlDatabase | null = null;
let durable = false;

export const browserDatabaseIsDurable = () => {
  browserDatabase();
  return durable;
};

function demoDatabase(): SqlDatabase {
  if (demo) return demo;
  const seeded = openMemoryDatabase();
  migrate(seeded);
  writeImport(seeded, demoSeed(Date.now(), newUuid, launchArguments().demoScale), DEMO_MARKER, "1");
  demo = seeded;
  return demo;
}

export function browserDatabase(): SqlDatabase {
  if (opened) return opened;
  if (launchArguments().isDemo) {
    opened = demoDatabase();
    return opened;
  }
  const file = openSqlDatabase(DATABASE_FILE);
  if ("refused" in migrate(file)) {
    const memory = openMemoryDatabase();
    migrate(memory);
    opened = memory;
  } else {
    opened = file;
    durable = true;
  }
  return opened;
}

export function relaxBrowserDatabase() {
  if (opened && durable) opened.exec(WAL_SAFE_COMMITS);
}

export const tabDatabase = (): SqlDatabase => (tabs ??= isDemoSession() ? demoDatabase() : browserDatabase());
