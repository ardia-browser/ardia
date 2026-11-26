import { hostSupports, invokeHost, type ArdiaHost } from "./host.ts";

const REPORT_FILES = "report.files";
const REPORT_SEND = "report.send";
export const REPORT_EXPORT_FOLDER_KEY = "ardia.report.exportFolder";
export const LOCAL_EVENTS_FILE = "local-events.jsonl.gz";

const FILE_METHODS: ReadonlySet<string> = new Set(["draftDirectory", "fileSize", "removeFile", "gzipFile", "gzipText"]);
const SEND_METHODS: ReadonlySet<string> = new Set(["upload", "post", "cancelUploads"]);

type FolderStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type ReportFile = { path: string; bytes: number };
type ReportReply = { status: number; body: string; error?: string | null };

const servesReportFiles = (host: ArdiaHost | undefined) => !!host && hostSupports(REPORT_FILES, host);
export const servesReportSheet = (host: ArdiaHost | undefined) => servesReportFiles(host) && hostSupports(REPORT_SEND, host!);

export function hostReportMethod(host: ArdiaHost, method: string): ((...args: unknown[]) => Promise<unknown>) | undefined {
  const capability = FILE_METHODS.has(method) ? REPORT_FILES : SEND_METHODS.has(method) ? REPORT_SEND : undefined;
  if (!capability || !hostSupports(capability, host)) return undefined;
  return (...args) => invokeHost(`ArdiaReport.${method}`, { args }, host);
}

const ownStorage = (): FolderStorage | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

const remembered = (storage: FolderStorage | undefined) => {
  try {
    return storage?.getItem(REPORT_EXPORT_FOLDER_KEY) || null;
  } catch {
    return null;
  }
};

const remember = (storage: FolderStorage | undefined, folder: string) => {
  try {
    storage?.setItem(REPORT_EXPORT_FOLDER_KEY, folder);
  } catch {
    return;
  }
};

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\\/;

export const draftFilePath = (folder: string, name: string) => `${folder}${WINDOWS_DRIVE_PATH.test(folder) ? "\\" : "/"}${name}`;

export function hostReportExport(host: ArdiaHost | undefined, storage: FolderStorage | undefined = ownStorage()): ((text: string) => Promise<ReportFile | null>) | undefined {
  if (!host || !servesReportFiles(host)) return undefined;
  const gzipInto = async (folder: string, text: string): Promise<ReportFile> => {
    const path = draftFilePath(folder, LOCAL_EVENTS_FILE);
    const bytes = await invokeHost<number>("ArdiaReport.gzipText", { args: [text, path] }, host);
    return { path, bytes };
  };
  return async (text) => {
    const kept = remembered(storage);
    if (kept) {
      const written = await gzipInto(kept, text).catch(() => null);
      if (written) return written;
    }
    const folder = await invokeHost<string>("ArdiaReport.draftDirectory", { args: [] }, host);
    remember(storage, folder);
    return gzipInto(folder, text);
  };
}

export function hostReportPost(host: ArdiaHost | undefined) {
  if (!host || !hostSupports(REPORT_SEND, host)) return undefined;
  return async (url: string, body: string, headers: Record<string, string>) => {
    const reply = await invokeHost<ReportReply>("ArdiaReport.post", { args: [url, body, headers] }, host);
    return { status: typeof reply?.status === "number" ? reply.status : 0, text: typeof reply?.body === "string" ? reply.body : "" };
  };
}
