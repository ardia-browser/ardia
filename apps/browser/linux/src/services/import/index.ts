import { BrowserWindow } from "electron";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { defineModule, emit } from "../../bridge";
import { isBackground } from "../../paths";
import { findBrowser, isChromiumBased } from "./browsers";
import { dataDirectory, listSources, profileDirectory } from "./discovery";
import { bookmarksFromHtml, passwordsFromCsv } from "./fileFormats";
import { pathFromFileUrl } from "./host";
import { importProfile, Unlocks } from "./importer";
import { ImportFailure, type ImportKind, type Options, type Progress } from "./model";
import { nodeImportHost } from "./nodeHost";
import { showOpenDialog } from "../../systemDialogs";

const LARGEST_FILE_BYTES = 64 << 20;
const NO_WRITE = { cookies: 0, cookiesRejected: 0, cookiesExisting: 0, addresses: 0, cards: 0 };
const FILE_FILTERS: Record<string, Electron.FileFilter[]> = {
  bookmarksHTML: [{ name: "Bookmarks", extensions: ["html", "htm"] }],
  passwordsCSV: [{ name: "Passwords", extensions: ["csv"] }],
  safariExport: [{ name: "Safari export", extensions: ["zip"] }],
};

const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

const host = nodeImportHost();
const unlocks = new Unlocks();
const cancelled = new Set<string>();

const rethrown = (error: unknown): never => {
  if (error instanceof ImportFailure) throw failure(error.code, error.message);
  throw error;
};

async function readFile(path: string) {
  const text = await host.readText(path, LARGEST_FILE_BYTES);
  if (text == null) throw failure("unreadable", "The file could not be read");
  return text;
}

type ChromiumExtensionSettings = Record<string, { manifest?: { name?: string }; from_webstore?: boolean; location?: number; state?: number; disable_reasons?: unknown }>;

function chromiumExtensions(profileDir: string) {
  const found = new Map<string, { id: string; name: string; webStoreUrl: string }>();
  for (const file of ["Secure Preferences", "Preferences"]) {
    let settings: ChromiumExtensionSettings = {};
    try {
      settings = (JSON.parse(readFileSync(join(profileDir, file), "utf8")) as { extensions?: { settings?: ChromiumExtensionSettings } }).extensions?.settings ?? {};
    } catch {
      continue;
    }
    for (const [id, entry] of Object.entries(settings)) {
      if (!entry?.from_webstore || entry.location !== 1 || found.has(id)) continue;
      const name = entry.manifest?.name ?? "";
      if (!name || name.startsWith("__MSG_")) continue;
      found.set(id, { id, name, webStoreUrl: `https://chromewebstore.google.com/detail/${id}` });
    }
  }
  return [...found.values()];
}

const notOnLinux = (what: string) => () => Promise.reject(failure("unsupported", `${what} isn't on Linux`));

defineModule("ArdiaImport", {
  sync: {
    cancelImport: (jobId: string) => void cancelled.add(jobId),
    isBrowserUnlocked: () => true,
    forgetUnlockedKeys: () => unlocks.forget(host),
    discardImported: (token: string) => host.discard(token),
    safariHasFullDiskAccess: () => false,
  },
  async: {
    listBrowsers: async () => JSON.stringify(await listSources(host)),
    importData: async (jobId: string, browserId: string, profileId: string, kinds: ImportKind[], options: Omit<Options, "historyPage"> | null) => {
      const send = (payload: object) => emit("ArdiaImport", "onImportEvent", { jobId, ...payload });
      try {
        const result = await importProfile(host, unlocks, browserId, profileId, kinds, options ?? {}, {
          progress: (progress: Progress) => send({ type: "progress", ...progress }),
          ...(options?.streamHistory ? { history: (entries) => send({ type: "history", entries: JSON.stringify(entries) }) } : {}),
          cancelled: () => cancelled.has(jobId),
        });
        return JSON.stringify(result);
      } catch (error) {
        return rethrown(error);
      } finally {
        cancelled.delete(jobId);
      }
    },
    unlockBrowser: async (browserId: string, primaryPassword: string | null) => {
      const browser = findBrowser(browserId);
      if (!browser) throw failure("notFound", `Unknown browser ${browserId}`);
      if (typeof primaryPassword === "string") host.usePrimaryPassword(primaryPassword);
      await unlocks.ensure(host, browser);
      return null;
    },
    writeImported: async (token: string, profile: string, kinds: string[]) => {
      const written = kinds.filter((kind): kind is "cookies" | "autofill" => kind === "cookies" || kind === "autofill");
      if (!written.length) {
        host.discard(token);
        return JSON.stringify(NO_WRITE);
      }
      return JSON.stringify(await host.writeImported(token, profile, written));
    },
    listExtensions: async (browserId: string, profileId: string) => {
      const browser = findBrowser(browserId);
      if (!browser || !isChromiumBased(browser)) return "[]";
      const { dir } = await profileDirectory(host, browser, profileId).catch(() => ({ dir: join(dataDirectory(host, browser), profileId) }));
      return JSON.stringify(chromiumExtensions(dir));
    },
    importBookmarksHTML: async (path: string) => JSON.stringify(await readFile(path).then((html) => bookmarksFromHtml(html, basename(path)), rethrown)),
    importPasswordsCSV: async (path: string) => JSON.stringify(await readFile(path).then(passwordsFromCsv, rethrown)),
    chooseImportFile: async (kind: string) => {
      if (isBackground()) {
        console.info(`[ardia dialogs] open panel for ${kind}`);
        return null;
      }
      const owner = BrowserWindow.getFocusedWindow();
      const options: Electron.OpenDialogOptions = { properties: ["openFile"], filters: FILE_FILTERS[kind] ?? [] };
      const { canceled, filePaths } = await showOpenDialog(owner, options);
      return canceled || !filePaths[0] ? null : pathFromFileUrl(filePaths[0]);
    },
    importSafariExport: notOnLinux("Safari"),
    importSafariDirect: notOnLinux("Safari"),
    openFullDiskAccessSettings: async () => null,
    readDiaTabs: notOnLinux("Dia"),
  },
});
