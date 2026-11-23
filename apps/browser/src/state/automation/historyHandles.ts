import { secureRandomBytes } from "../../platform/secureRandom";

export type HistoryPage = { url: string; profileId: string; engine: string };

const MAX_HANDLES = 20_000;
const tables = new Map<number, { byId: Map<string, HistoryPage>; byPage: Map<string, string> }>();

const pageKey = (page: HistoryPage) => `${page.profileId}\n${page.engine}\n${page.url}`;

function randomHandle(taken: Map<string, HistoryPage>): string {
  for (;;) {
    const id = `h${Array.from(secureRandomBytes(20), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    if (!taken.has(id)) return id;
  }
}

type HandleScope = { connection: number; serving: () => boolean };

class AbandonedRequest extends Error {}

export function historyHandle(scope: HandleScope, page: HistoryPage): string {
  if (!scope.serving()) throw new AbandonedRequest("The connection closed or control went off before the search finished, so it was dropped.");
  const connection = scope.connection;
  let table = tables.get(connection);
  if (!table) tables.set(connection, (table = { byId: new Map(), byPage: new Map() }));
  const key = pageKey(page);
  const known = table.byPage.get(key);
  if (known) return known;
  const id = randomHandle(table.byId);
  table.byId.set(id, page);
  table.byPage.set(key, id);
  while (table.byId.size > MAX_HANDLES) {
    const [oldest, stale] = table.byId.entries().next().value!;
    table.byId.delete(oldest);
    table.byPage.delete(pageKey(stale));
  }
  return id;
}

export const historyPageOf = (connection: number, id: string): HistoryPage | undefined => tables.get(connection)?.byId.get(id);

export const dropHistoryHandles = (connection: number) => void tables.delete(connection);

export const dropAllHistoryHandles = () => tables.clear();
