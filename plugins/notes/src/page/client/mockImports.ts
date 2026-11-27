import { importSource, type ImportJob, type ImportPick, type ImportSourceId } from "../../shared/importSources";
import type { PageId, WorkspaceId } from "../../shared/protocol";

const FILES = ["index.md", "Meeting notes.md", "Ideas.md", "Reading list.csv", "assets/cover.png", "Trip.md", "Journal/2026-11-20.md", "Journal/2026-11-21.md"];

export const mockGettingStarted = [
  { type: "paragraph", content: "Welcome to Notes. Everything here lives on this Mac." },
  { type: "heading", props: { level: 2 }, content: "The basics" },
  { type: "checkListItem", props: { checked: true }, content: "Click anywhere and just start typing" },
  { type: "checkListItem", props: { checked: false }, content: "Press / for headings, lists, tables and more" },
  { type: "checkListItem", props: { checked: false }, content: "Type [[ to link another page" },
  { type: "paragraph", content: "" },
];

export function createMockImports({ finish }: { finish: (workspace: WorkspaceId, title: string) => PageId }) {
  const jobs = new Map<string, ImportJob>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  let latest: string | null = null;
  const startParams = new URLSearchParams(location.search);
  const params = () => startParams;

  const stop = (id: string) => {
    const timer = timers.get(id);
    if (timer) clearInterval(timer);
    timers.delete(id);
  };

  return {
    start(workspace: WorkspaceId, source: ImportSourceId, pick: ImportPick): { job: string } | null {
      if (params().has("importPickCancel")) return null;
      const id = Math.random().toString(16).slice(2, 14);
      const fail = params().has("importFail");
      const total = Number(params().get("importMs") ?? 1500);
      const job: ImportJob = { id, source, workspace, state: "reading", files: FILES.length, filesDone: 0, pages: 0, databases: 0, attachments: 0, skipped: 0, current: FILES[0]!, startedAt: Date.now() };
      void pick;
      jobs.set(id, job);
      latest = id;
      const stepMs = Math.max(20, Math.round(total / FILES.length));
      timers.set(
        id,
        setInterval(() => {
          const j = jobs.get(id);
          if (!j || j.state === "cancelled") return stop(id);
          const done = j.filesDone + 1;
          const file = FILES[Math.min(done, FILES.length - 1)]!;
          const next: ImportJob = { ...j, filesDone: done, current: file, state: done > FILES.length / 2 ? "writing" : "reading" };
          if (FILES[done - 1]?.endsWith(".md")) next.pages = j.pages + 1;
          if (FILES[done - 1]?.endsWith(".csv")) next.databases = j.databases + 1;
          if (FILES[done - 1]?.endsWith(".png")) next.attachments = j.attachments + 1;
          if (fail && done >= 3) {
            jobs.set(id, { ...next, state: "failed", error: "“Reading list.csv” isn’t a CSV file Notes can read.", finishedAt: Date.now() });
            return stop(id);
          }
          if (done >= FILES.length) {
            const root = finish(workspace, `${importSource(source)?.title ?? "Notes"} import`);
            jobs.set(id, { ...next, filesDone: FILES.length, current: "", state: "done", root, finishedAt: Date.now() });
            return stop(id);
          }
          jobs.set(id, next);
        }, stepMs),
      );
      return { job: id };
    },
    status(id?: string): ImportJob | null {
      const key = id ?? latest;
      return key ? (jobs.get(key) ?? null) : null;
    },
    cancel(id: string): null {
      const j = jobs.get(id);
      if (j && (j.state === "reading" || j.state === "writing")) jobs.set(id, { ...j, state: "cancelled", finishedAt: Date.now() });
      stop(id);
      return null;
    },
  };
}

const NOTES_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="4" y="4" width="56" height="56" rx="13" fill="#fff"/><path d="M4 17a13 13 0 0 1 13-13h30a13 13 0 0 1 13 13v3H4z" fill="#f7c331"/><g stroke="#d6d6d6" stroke-width="1.5"><path d="M12 30h40M12 38h40M12 46h40"/></g></svg>`;

const noAppIcon = new URLSearchParams(location.search).has("noAppIcon");

export function mockAppIcon(): { icon: string | null } {
  if (noAppIcon) return { icon: null };
  return { icon: `data:image/svg+xml;base64,${btoa(NOTES_ICON_SVG)}` };
}
