import type { NotionAccount, NotionCrawl } from "../../shared/notionLive";

const SPACES = [
  { id: "1f2e3d4c-0000-4000-8000-000000000001", name: "Acme", icon: "🚀", role: "owner" as const, canImport: true },
  { id: "1f2e3d4c-0000-4000-8000-000000000002", name: "Side projects", icon: "", role: "member" as const, canImport: true },
];

export function createMockNotion() {
  let job: NotionCrawl | null = null;
  const search = typeof location === "undefined" ? "" : location.search;
  let signedIn = !/notion=signedout/.test(search);
  const unsupported = /notion=unsupported/.test(search);
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  return {
    account(): NotionAccount {
      if (unsupported) return { state: "unsupported" };
      return signedIn ? { state: "signedIn", user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" }, spaces: SPACES } : { state: "signedOut" };
    },
    signIn() {
      signedIn = true;
    },
    start(space: string): NotionCrawl {
      const found = SPACES.find((s) => s.id === space) ?? SPACES[0]!;
      stop();
      job = { stage: "reading", spaceId: found.id, spaceName: found.name, pagesFound: 12, pagesRead: 0, blocks: 0, databases: 0, rows: 0, filesFound: 0, filesDone: 0, filesSkipped: 0, skipped: 0, startedAt: Date.now() };
      timer = setInterval(() => {
        if (!job) return stop();
        if (job.stage === "reading") {
          const pagesFound = Math.min(320, job.pagesFound + 41);
          job = { ...job, pagesFound, pagesRead: Math.min(pagesFound, job.pagesRead + 37), blocks: job.blocks + 640, databases: Math.min(6, job.databases + 1) };
          if (job.pagesRead >= 320) job = { ...job, stage: "downloading", filesFound: 24 };
        } else if (job.stage === "downloading") {
          job = { ...job, filesDone: Math.min(job.filesFound, job.filesDone + 4) };
          if (job.filesDone >= job.filesFound) {
            job = { ...job, stage: "ready" };
            stop();
          }
        }
      }, 300);
      return { ...job };
    },
    status: (): NotionCrawl | null => (job ? { ...job } : null),
    cancel() {
      stop();
      if (job && (job.stage === "reading" || job.stage === "downloading")) job = { ...job, stage: "cancelled" };
    },
  };
}
