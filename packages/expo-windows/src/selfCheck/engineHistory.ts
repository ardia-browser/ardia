import { engineAvailable, engineCallJson } from "../engine/host";
import { expectEqual, type Check } from "./check";

const DAY_MS = 86_400_000;
const LOOK_MS = 10_000;
const POLL_MS = 200;
const OLD_PAGE = "https://ardia-history-check.example/kept-120-days";
const RECENT_PAGE = "https://ardia-history-check.example/kept-5-days";

type HistoryEntry = { u?: unknown };

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function historyUrls(): Promise<string[]> {
  const reply = JSON.parse(await engineCallJson("ac_history_query", "", JSON.stringify({ maxUrls: 5000, maxVisits: 1 }))) as { entries?: HistoryEntry[] };
  return (reply.entries ?? []).map((entry) => String(entry.u));
}

const historyChecks: Check[] = [
  {
    name: "engine history: an imported page last visited 120 days ago is kept, as on the Mac (keep-old-history)",
    async run() {
      const now = Date.now();
      const imported = JSON.parse(
        await engineCallJson(
          "ac_history_import",
          "",
          JSON.stringify({
            rows: [
              { u: OLD_PAGE, t: "a page from 120 days ago", n: 1, l: now - 120 * DAY_MS },
              { u: RECENT_PAGE, t: "a page from 5 days ago", n: 1, l: now - 5 * DAY_MS },
            ],
          }),
        ),
      ) as { error?: unknown };
      expectEqual(imported.error, undefined, "the import's error");
      const by = Date.now() + LOOK_MS;
      let urls = await historyUrls();
      while (!urls.includes(RECENT_PAGE) && Date.now() < by) {
        await pause(POLL_MS);
        urls = await historyUrls();
      }
      expectEqual({ recent: urls.includes(RECENT_PAGE), old: urls.includes(OLD_PAGE) }, { recent: true, old: true }, "the imported pages in history");
    },
  },
];

export const checks: Check[] = engineAvailable() ? historyChecks : [];
