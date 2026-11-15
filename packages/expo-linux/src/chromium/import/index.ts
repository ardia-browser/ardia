import { BROWSERS, findBrowser, isChromiumBased } from "../../../../../apps/browser/linux/src/services/import/browsers";
import { dataDirectory, listSources, profileDirectory } from "../../../../../apps/browser/linux/src/services/import/discovery";
import { bookmarksFromHtml, passwordsFromCsv } from "../../../../../apps/browser/linux/src/services/import/fileFormats";
import { join, pathFromFileUrl, type ImportHost } from "../../../../../apps/browser/linux/src/services/import/host";
import { importProfile, Unlocks } from "../../../../../apps/browser/linux/src/services/import/importer";
import { ImportFailure, type ImportKind, type Options, type Progress } from "../../../../../apps/browser/linux/src/services/import/model";
import { knowExistingPaths } from "../../../../../apps/browser/linux/src/services/import/paths.chromium";
import { callMain, mainModules } from "../../bridge";
import { emitNativeEvent } from "../events";

const NATIVE = "ArdiaLinuxImport";
const LARGEST_FILE_BYTES = 64 << 20;
const NO_WRITE = { cookies: 0, cookiesRejected: 0, cookiesExisting: 0, addresses: 0, cards: 0 };

const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

const native = <Value>(method: string, ...args: unknown[]) => callMain<Value>(NATIVE, method, ...args) as Promise<Value>;

function home(): string {
  const value = mainModules()[NATIVE]?.constants?.home;
  return typeof value === "string" ? value : "";
}

export function engineImportHost(): ImportHost & { usePrimaryPassword(password: string): Promise<void> } {
  return {
    home: home(),
    list: (path) => native("list", path),
    readText: (path, largest) => native("readText", path, largest),
    readBase64: (path, largest) => native("readBase64", path, largest),
    readTextWithin: (folder, path, largest) => native("readTextWithin", folder, path, largest),
    readBase64Within: (folder, path, largest) => native("readBase64Within", folder, path, largest),
    query: (path, queries) => native("query", path, queries),
    openSnapshot: (path) => native("openSnapshot", path),
    querySnapshot: (id, queries) => native("querySnapshot", id, queries),
    closeSnapshot: (id) => void native("closeSnapshot", id).catch(() => undefined),
    unlock: (browserId) => native("unlock", browserId, findBrowser(browserId)?.keyring ?? ""),
    logins: (browserId, files) => native("logins", browserId, files),
    cookies: (browserId, file) => native("cookies", browserId, file),
    firefoxLogins: (profile) => native("firefoxLogins", profile),
    firefoxCookies: (file) => native("firefoxCookies", file),
    autofill: (browserId, file, joinToken) => native("autofill", browserId, file, joinToken),
    writeImported: (token, profile, kinds) => native("writeImported", token, profile, kinds),
    discard: (token) => void native("discard", token).catch(() => undefined),
    forget: () => void native("forget").catch(() => undefined),
    usePrimaryPassword: async (password) => void (await native("usePrimaryPassword", password)),
  };
}

let host: ReturnType<typeof engineImportHost> | null = null;
const unlocks = new Unlocks();
const cancelled = new Set<string>();

function hostNow() {
  host ??= engineImportHost();
  return host;
}

async function knowDataDirectories(current: ImportHost): Promise<void> {
  const candidates = BROWSERS.flatMap((browser) => browser.paths.map((path) => join(current.home, path)));
  knowExistingPaths((await native<string[] | null>("existing", candidates).catch(() => null)) ?? []);
}

const rethrown = (error: unknown): never => {
  if (error instanceof ImportFailure) throw failure(error.code, error.message);
  throw error;
};

async function readFile(path: string) {
  const text = await hostNow().readText(path, LARGEST_FILE_BYTES);
  if (text == null) throw failure("unreadable", "The file could not be read");
  return text;
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

type ChromiumExtensionSettings = Record<string, { manifest?: { name?: string }; from_webstore?: boolean; location?: number }>;

async function chromiumExtensions(current: ImportHost, profileDir: string) {
  const found = new Map<string, { id: string; name: string; webStoreUrl: string }>();
  for (const file of ["Secure Preferences", "Preferences"]) {
    let settings: ChromiumExtensionSettings = {};
    try {
      const text = await current.readTextWithin(profileDir, file, LARGEST_FILE_BYTES);
      if (!text) continue;
      settings = (JSON.parse(text) as { extensions?: { settings?: ChromiumExtensionSettings } }).extensions?.settings ?? {};
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

const FILE_TYPES: Record<string, string[]> = { bookmarksHTML: ["html", "htm"], passwordsCSV: ["csv"] };

async function chooseImportFile(kind: string): Promise<string | null> {
  const picked = await callMain<string[] | null>("ArdiaDialogs", "pickFiles");
  const path = picked?.[0];
  if (!path) return null;
  const wanted = FILE_TYPES[kind];
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (wanted && !wanted.includes(extension)) throw failure("unsupported", "That file isn't the right kind");
  return pathFromFileUrl(path);
}

export const importModules: Record<string, Record<string, unknown>> = {
  ArdiaImport: {
    cancelImport: (jobId: string) => void cancelled.add(jobId),
    isBrowserUnlocked: () => true,
    forgetUnlockedKeys: () => unlocks.forget(hostNow()),
    discardImported: (token: string) => hostNow().discard(token),
    safariHasFullDiskAccess: () => false,
    listBrowsers: async () => {
      const current = hostNow();
      await knowDataDirectories(current);
      return JSON.stringify(await listSources(current));
    },
    importData: async (jobId: string, browserId: string, profileId: string, kinds: ImportKind[], options: Omit<Options, "historyPage"> | null) => {
      const current = hostNow();
      await knowDataDirectories(current);
      const send = (payload: object) => emitNativeEvent("ArdiaImport", "onImportEvent", { jobId, ...payload });
      try {
        const result = await importProfile(current, unlocks, browserId, profileId, kinds, options ?? {}, {
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
      const current = hostNow();
      await knowDataDirectories(current);
      if (typeof primaryPassword === "string") await current.usePrimaryPassword(primaryPassword);
      await unlocks.ensure(current, browser);
      return null;
    },
    writeImported: async (token: string, profile: string, kinds: string[]) => {
      const written = kinds.filter((kind): kind is "cookies" | "autofill" => kind === "cookies" || kind === "autofill");
      if (!written.length) {
        hostNow().discard(token);
        return JSON.stringify(NO_WRITE);
      }
      return JSON.stringify(await hostNow().writeImported(token, profile, written));
    },
    listExtensions: async (browserId: string, profileId: string) => {
      const browser = findBrowser(browserId);
      if (!browser || !isChromiumBased(browser)) return "[]";
      const current = hostNow();
      await knowDataDirectories(current);
      const { dir } = await profileDirectory(current, browser, profileId).catch(() => ({ dir: join(dataDirectory(current, browser), profileId) }));
      return JSON.stringify(await chromiumExtensions(current, dir));
    },
    importBookmarksHTML: async (path: string) => JSON.stringify(await readFile(path).then((html) => bookmarksFromHtml(html, baseName(path)), rethrown)),
    importPasswordsCSV: async (path: string) => JSON.stringify(await readFile(path).then(passwordsFromCsv, rethrown)),
    chooseImportFile,
    importSafariExport: notOnLinux("Safari"),
    importSafariDirect: notOnLinux("Safari"),
    openFullDiskAccessSettings: async () => null,
    readDiaTabs: notOnLinux("Dia"),
  },
};
