export type ImportSourceId = "notion" | "obsidian" | "logseq" | "bear" | "evernote" | "apple-notes" | "roam" | "keep" | "joplin" | "simplenote" | "craft" | "markdown";

export type ImportPick = "file" | "folder" | "app" | "account";

export type ImportSourceInfo = {
  id: ImportSourceId;
  title: string;
  hint: string;
  picks: ImportPick[];
  extensions: string[];
  monogram: string;
};

export const IMPORT_SOURCES: ImportSourceInfo[] = [
  { id: "notion", title: "Notion", hint: "In Notion, open Settings › Export all workspace content, pick Markdown & CSV, and choose the .zip it downloads.", picks: ["file", "folder"], extensions: ["zip", "md", "csv", "html"], monogram: "N" },
  { id: "obsidian", title: "Obsidian", hint: "Choose your vault's folder. Links, embeds, frontmatter, callouts and attachments come along.", picks: ["folder"], extensions: ["md"], monogram: "O" },
  { id: "logseq", title: "Logseq", hint: "Choose your graph's folder, the one holding journals and pages.", picks: ["folder"], extensions: ["md"], monogram: "L" },
  { id: "bear", title: "Bear", hint: "In Bear, select notes, choose File › Export Notes as Markdown or TextBundle, then pick that folder.", picks: ["folder", "file"], extensions: ["md", "textbundle", "zip"], monogram: "B" },
  { id: "evernote", title: "Evernote", hint: "In Evernote, export a notebook as an .enex file and choose it.", picks: ["file"], extensions: ["enex"], monogram: "E" },
  { id: "apple-notes", title: "Apple Notes", hint: "Reads your notes straight from the Notes app on this Mac, after you allow it. Locked notes stay locked.", picks: ["app", "folder"], extensions: ["md", "html", "txt"], monogram: "A" },
  { id: "roam", title: "Roam", hint: "In Roam, choose ⋯ › Export All › JSON and pick the .json or .zip it downloads.", picks: ["file"], extensions: ["json", "zip"], monogram: "R" },
  { id: "keep", title: "Google Keep", hint: "Download Keep from Google Takeout, unzip it, and choose the Keep folder (or the .zip).", picks: ["folder", "file"], extensions: ["json", "html", "zip"], monogram: "K" },
  { id: "joplin", title: "Joplin", hint: "In Joplin, choose File › Export all › JEX and pick the .jex file.", picks: ["file"], extensions: ["jex"], monogram: "J" },
  { id: "simplenote", title: "Simplenote", hint: "In Simplenote, choose Settings › Export notes and pick the .zip it downloads.", picks: ["file"], extensions: ["zip", "json"], monogram: "S" },
  { id: "craft", title: "Craft", hint: "In Craft, export a space or documents as Markdown and pick that folder or .zip.", picks: ["folder", "file"], extensions: ["md", "zip"], monogram: "C" },
  { id: "markdown", title: "Markdown & text", hint: "Choose a folder of Markdown, HTML or text files, or a single file. Folders become pages.", picks: ["folder", "file"], extensions: ["md", "markdown", "txt", "html", "htm", "zip"], monogram: "M" },
];

export const importSource = (id: string): ImportSourceInfo | null => IMPORT_SOURCES.find((s) => s.id === id) ?? null;

export const IMPORT_SOURCE_IDS = IMPORT_SOURCES.map((s) => s.id);

export const FEATURED_SOURCES: ImportSourceId[] = ["notion", "obsidian", "evernote", "apple-notes"];

export type ImportState = "reading" | "writing" | "done" | "failed" | "cancelled";

export type ImportJob = {
  id: string;
  source: ImportSourceId;
  workspace: string;
  state: ImportState;
  files: number;
  filesDone: number;
  pages: number;
  databases: number;
  attachments: number;
  skipped: number;
  conflicts?: number;
  current: string;
  error?: string;
  root?: string;
  roots?: string[];
  startedAt: number;
  finishedAt?: number;
};

export type StarterId = "journal" | "tasks" | "reading" | "projects" | "blank";

export const STARTER_IDS: StarterId[] = ["journal", "tasks", "reading", "projects", "blank"];
