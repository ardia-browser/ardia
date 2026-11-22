import { useBrowser } from "../browser/store";

export const LATE_LIMIT_MS = 60_000;

type Outstanding = { owner: number | null; token: object; timer: ReturnType<typeof setTimeout> };

const outstanding = new Map<string, Outstanding>();
const late = new Map<number, Map<string, string>>();
let generation = 0;

function free(tabId: string) {
  const entry = outstanding.get(tabId);
  if (!entry) return;
  clearTimeout(entry.timer);
  outstanding.delete(tabId);
}

export function isTabBusy(tabId: string): boolean {
  if (!outstanding.has(tabId)) return false;
  if (useBrowser.getState().tabs[tabId]) return true;
  free(tabId);
  return false;
}

export function awaitLate(tabId: string, work: Promise<string>, scope: { connection: number; serving: () => boolean }) {
  if (!scope.serving()) return;
  const owner = scope.connection;
  free(tabId);
  const token = {};
  const startedIn = generation;
  const timer = setTimeout(() => {
    if (outstanding.get(tabId)?.token === token) outstanding.delete(tabId);
  }, LATE_LIMIT_MS);
  outstanding.set(tabId, { owner, token, timer });
  void work
    .catch(() => "failed")
    .then((outcome) => {
      const entry = outstanding.get(tabId);
      if (entry?.token !== token) return;
      free(tabId);
      if (startedIn !== generation || entry.owner === null || !useBrowser.getState().tabs[tabId]) return;
      const results = late.get(entry.owner) ?? new Map<string, string>();
      results.set(tabId, outcome);
      late.set(entry.owner, results);
    });
}

export function takeLateResults(connection: number): Record<string, string> | null {
  const results = late.get(connection);
  if (!results?.size) return null;
  late.delete(connection);
  return Object.fromEntries(results);
}

export function dropLateResults(connection: number) {
  late.delete(connection);
  for (const entry of outstanding.values()) if (entry.owner === connection) entry.owner = null;
}

export function forgetTabCalls() {
  generation++;
  for (const entry of outstanding.values()) clearTimeout(entry.timer);
  outstanding.clear();
  late.clear();
}
