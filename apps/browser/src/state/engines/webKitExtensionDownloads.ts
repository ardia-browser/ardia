import { providerText } from "@ardia/core";
import { cancelDownload, getDownloadSettings, keepDownload, pauseDownload, resumeDownload, type Download } from "../../platform/downloads";
import { confirm } from "../../platform/dialogs";
import { listExtensions } from "../../platform/extensions";
import { moveToTrash, openFile, revealFile } from "../../platform/files";
import type { WebKitExtensionCall } from "../../platform/webkit";
import { storeAction, useBrowser, type BrowserState } from "../browser/store";
import { chromeDownload, downloadsFor, keyFor, numberFor, type ChromeDownload } from "./webKitExtensionData";

export class DownloadApiError extends Error {}

const fail = (message: string): never => {
  throw new DownloadApiError(message);
};

type Handler = (call: WebKitExtensionCall, s: BrowserState) => unknown;
type Options = Record<string, unknown>;

const store = () => useBrowser.getState();
const optionsOf = (value: unknown): Options => (value && typeof value === "object" && !Array.isArray(value) ? (value as Options) : {});
const textOf = (value: unknown) => (typeof value === "string" ? value : "");
const DOWNLOAD_START_MS = 10_000;
const SHOWN_NAME = 80;

const removeDownload = storeAction("removeDownload");

function downloadOf(call: WebKitExtensionCall, s: BrowserState, id: unknown): Download {
  const list = downloadsFor(s, call.profile, call.base, call.private);
  const key = keyFor("download", id, () => list.map((d) => d.id));
  const found = key ? list.find((d) => d.id === key) : undefined;
  return found ?? fail(`Invalid download id ${String(id)}`);
}

const MAX_PATTERN = 256;
const MAX_MATCHED = 1024;
const SEARCH_BUDGET_MS = 200;
const REFERS_BACK = /\\[1-9]|\\k<|\(\?<?[=!]/;
const REPEATS = new Set(["*", "+", "{"]);
const MAX_UNBOUNDED_REPEATS = 2;
const MAX_QUANTIFIERS = 6;
const BRACE_QUANTIFIER = /^\{(\d+)(,(\d*))?\}/;
const MAX_BOUNDED_REPEAT = 16;
const unboundedBrace = (brace: RegExpExecArray | null) => !!brace && Math.max(Number(brace[1]), brace[2] ? (brace[3] ? Number(brace[3]) : Infinity) : 0) > MAX_BOUNDED_REPEAT;

function backtracks(pattern: string): boolean {
  if (REFERS_BACK.test(pattern)) return true;
  const open: boolean[] = [];
  let unbounded = 0;
  let quantifiers = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
    } else if (c === "[") {
      for (i++; i < pattern.length && pattern[i] !== "]"; i++) if (pattern[i] === "\\") i++;
    } else if (c === "(") {
      open.push(false);
    } else if (c === "?") {
      if (!"(*+?}".includes(pattern[i - 1] ?? "(")) quantifiers++;
    } else if (c === "|" || REPEATS.has(c!)) {
      const brace = c === "{" ? BRACE_QUANTIFIER.exec(pattern.slice(i)) : null;
      if (c === "*" || c === "+" || unboundedBrace(brace)) unbounded++;
      if (c !== "|" && (c !== "{" || brace)) quantifiers++;
      if (open.length) open[open.length - 1] = true;
    } else if (c === ")") {
      const branching = open.pop() ?? false;
      if (branching && REPEATS.has(pattern[i + 1] ?? "")) return true;
      if (branching && open.length) open[open.length - 1] = true;
    }
  }
  return unbounded > (pattern.startsWith("^") ? MAX_UNBOUNDED_REPEATS : 1) || quantifiers > MAX_QUANTIFIERS;
}

const matches = (pattern: RegExp, value: string) => pattern.test(value.length > MAX_MATCHED ? value.slice(0, MAX_MATCHED) : value);

function patternOf(pattern: unknown): RegExp | null {
  if (typeof pattern !== "string") return null;
  if (pattern.length > MAX_PATTERN || backtracks(pattern)) return fail("Invalid query filter");
  try {
    return new RegExp(pattern);
  } catch {
    return fail("Invalid query filter");
  }
}

export function searchDownloads(items: ChromeDownload[], query: Options): ChromeDownload[] {
  const terms = (textOf(query.query) ? textOf(query.query).split(/\s+/) : Array.isArray(query.query) ? query.query.map(textOf) : []).filter((t) => t && t !== "-");
  const urlPattern = patternOf(query.urlRegex);
  const finalUrlPattern = patternOf(query.finalUrlRegex);
  const filenamePattern = patternOf(query.filenameRegex);
  const started = Date.now();
  const found = items.filter((d) => {
    if ((urlPattern || finalUrlPattern || filenamePattern) && Date.now() - started > SEARCH_BUDGET_MS) fail("The search took too long; try a narrower pattern.");
    if (typeof query.id === "number" && d.id !== query.id) return false;
    if (typeof query.url === "string" && d.url !== query.url && d.finalUrl !== query.url) return false;
    if (typeof query.filename === "string" && d.filename !== query.filename) return false;
    if (typeof query.state === "string" && d.state !== query.state) return false;
    if (typeof query.paused === "boolean" && d.paused !== query.paused) return false;
    if (typeof query.exists === "boolean" && d.exists !== query.exists) return false;
    if (typeof query.mime === "string" && d.mime !== query.mime) return false;
    if (typeof query.danger === "string" && d.danger !== query.danger) return false;
    if (typeof query.finalUrl === "string" && d.finalUrl !== query.finalUrl) return false;
    if (urlPattern && !matches(urlPattern, d.url)) return false;
    if (finalUrlPattern && !matches(finalUrlPattern, d.finalUrl)) return false;
    if (filenamePattern && !matches(filenamePattern, d.filename)) return false;
    const haystack = `${d.url} ${d.filename}`.toLowerCase();
    return terms.every((t) => (t.startsWith("-") ? !haystack.includes(t.slice(1).toLowerCase()) : haystack.includes(t.toLowerCase())));
  });
  const order = Array.isArray(query.orderBy) ? query.orderBy.map(textOf) : [];
  for (const field of [...order].reverse()) {
    const name = field.replace(/^-/, "") as keyof ChromeDownload;
    const sign = field.startsWith("-") ? -1 : 1;
    found.sort((a, b) => {
      const x = a[name] ?? "";
      const y = b[name] ?? "";
      return x < y ? -sign : x > y ? sign : 0;
    });
  }
  const limit = typeof query.limit === "number" ? query.limit : 1000;
  return limit > 0 ? found.slice(0, limit) : found;
}

function waitForDownload(url: string, before: ReadonlySet<string>, id?: string): Promise<number> {
  const pick = (s: BrowserState) => s.downloads.find((d) => (id ? d.id === id : d.url === url && !before.has(d.id)));
  const now = pick(store());
  if (now) return Promise.resolve(numberFor("download", now.id));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new DownloadApiError("The download didn't start."));
    }, DOWNLOAD_START_MS);
    const stop = useBrowser.subscribeTo(["downloads"], (s) => {
      const found = pick(s);
      if (!found) return;
      clearTimeout(timer);
      stop();
      resolve(numberFor("download", found.id));
    });
  });
}

const downloadsSeen = (s: BrowserState) => new Set(s.downloads.map((d) => d.id));

const answeredInTime = (call: WebKitExtensionCall) => call.answerBy === undefined || Date.now() <= call.answerBy;

export const downloadHandlers: Record<string, Handler> = {
  download: (call, s) => {
    const started = optionsOf(call.args[0]);
    return waitForDownload(textOf(started.url), downloadsSeen(s), typeof started.id === "string" && started.id ? started.id : undefined);
  },
  search: (call, s) => searchDownloads(downloadsFor(s, call.profile, call.base, call.private).map((d) => chromeDownload(d)), optionsOf(call.args[0])),
  pause: async (call, s) => void (await pauseDownload(downloadOf(call, s, call.args[0]).id)),
  resume: async (call, s) => void (await resumeDownload(downloadOf(call, s, call.args[0]).id)),
  cancel: async (call, s) => void (await cancelDownload(downloadOf(call, s, call.args[0]).id)),
  acceptDanger: async (call, s) => {
    const d = downloadOf(call, s, call.args[0]);
    if (d.state !== "downloading") fail("Download must be in progress");
    if (!d.dangerous) return void (await keepDownload(d.id));
    const { confirmed } = await confirm({
      title: `Keep “${d.filename}”?`,
      message: "An extension wants to keep this file. It might harm your files or your privacy.",
      confirmTitle: "Keep",
      destructive: true,
    });
    if (confirmed && answeredInTime(call) && store().downloads.some((x) => x.id === d.id && x.state === "downloading")) await keepDownload(d.id);
  },
  erase: (call, s) => {
    const list = downloadsFor(s, call.profile, call.base, call.private);
    const erased = searchDownloads(list.map((d) => chromeDownload(d)), optionsOf(call.args[0]));
    for (const d of erased) {
      const key = keyFor("download", d.id, () => list.map((item) => item.id));
      if (key) removeDownload(key);
    }
    return erased.map((d) => d.id);
  },
  open: async (call, s) => {
    const d = downloadOf(call, s, call.args[0]);
    if (d.state !== "finished") fail("Download must be complete");
    const asker = (await listExtensions(call.base)).find((x) => x.id === call.extensionId)?.name;
    const { confirmed } = await confirm({
      title: `Open “${providerText(d.filename, SHOWN_NAME) || "this file"}”?`,
      message: asker ? `“${providerText(asker, SHOWN_NAME)}” wants to open this file.` : "An extension wants to open this file.",
      confirmTitle: "Open",
    });
    if (!confirmed) fail("The user didn't allow the file to open.");
    if (!answeredInTime(call)) fail("Download open timed out.");
    await openFile(d.path);
  },
  show: async (call, s) => void (await revealFile(downloadOf(call, s, call.args[0]).path)),
  showDefaultFolder: async (call) => {
    const { folder } = await getDownloadSettings(call.base);
    if (folder) await openFile(folder);
  },
  removeFile: async (call, s) => {
    const d = downloadOf(call, s, call.args[0]);
    if (d.state !== "finished") fail("Download must be complete");
    await moveToTrash(d.path);
  },
  getFileIcon: () => fail("Not supported"),
  setUiOptions: () => undefined,
  setShelfEnabled: () => undefined,
};
