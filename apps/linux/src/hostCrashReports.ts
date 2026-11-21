import type { CrashProcess, CrashReport } from "../../../packages/shell/src/app";
import { hostSupports, invokeHost, type ArdiaHost } from "./host.ts";
import { parseMinidump, type Minidump, type MinidumpModule } from "./minidump.ts";

export const CRASH_DUMPS = "crash.dumps";
export type CrashDumpEntry = { id: string; time: number };

const PER_PROCESS_KIND = 5;
const READ_AT_MOST = 16;
const IMAGES_AT_MOST = 24;
const SIMULATED_SIGNAL = 0xffffffff;
const VERSION_KEY = "ardia-ver";
const APP_VERSION = /^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/;

const SIGNALS: Record<number, string> = { 4: "SIGILL", 5: "SIGTRAP", 6: "SIGABRT", 7: "SIGBUS", 8: "SIGFPE", 11: "SIGSEGV", 31: "SIGSYS" };

const GENERIC_CODES: Record<number, string> = { 0: "SI_USER", 128: "SI_KERNEL", [-1]: "SI_QUEUE", [-6]: "SI_TKILL" };

const SIGNAL_CODES: Record<string, Record<number, string>> = {
  SIGSEGV: { 1: "SEGV_MAPERR", 2: "SEGV_ACCERR", 3: "SEGV_BNDERR", 4: "SEGV_PKUERR" },
  SIGBUS: { 1: "BUS_ADRALN", 2: "BUS_ADRERR", 3: "BUS_OBJERR", 4: "BUS_MCEERR_AR", 5: "BUS_MCEERR_AO" },
  SIGILL: { 1: "ILL_ILLOPC", 2: "ILL_ILLOPN", 3: "ILL_ILLADR", 4: "ILL_ILLTRP", 5: "ILL_PRVOPC", 6: "ILL_PRVREG", 7: "ILL_COPROC", 8: "ILL_BADSTK" },
  SIGTRAP: { 1: "TRAP_BRKPT", 2: "TRAP_TRACE", 3: "TRAP_BRANCH", 4: "TRAP_HWBKPT" },
  SIGFPE: { 1: "FPE_INTDIV", 2: "FPE_INTOVF", 3: "FPE_FLTDIV", 4: "FPE_FLTOVF", 5: "FPE_FLTUND", 6: "FPE_FLTRES", 7: "FPE_FLTINV", 8: "FPE_FLTSUB" },
  SIGSYS: { 1: "SYS_SECCOMP" },
};

const PROCESS_KINDS: Record<string, CrashProcess> = { browser: "browser", renderer: "renderer", extension: "renderer", "gpu-process": "gpu", ppapi: "plugin" };

export const servesCrashDumps = (host: ArdiaHost | undefined) => !!host && hostSupports(CRASH_DUMPS, host);

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1) || "???";
const folder = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

function bundledImages(dump: Minidump): { name: string; uuid: string }[] {
  const main = dump.modules[0];
  if (!main?.path.startsWith("/")) return [];
  const home = folder(main.path);
  const seen = new Set<string>();
  const images: { name: string; uuid: string }[] = [];
  for (const module of dump.modules) {
    if (!module.buildId || folder(module.path) !== home || seen.has(module.buildId)) continue;
    seen.add(module.buildId);
    images.push({ name: baseName(module.path), uuid: module.buildId });
    if (images.length === IMAGES_AT_MOST) break;
  }
  return images;
}

const frameOf = ({ module, address }: { module: MinidumpModule | null; address: bigint }) =>
  module ? { image: baseName(module.path), offset: Number(address - module.base) } : { image: "???" };

export function linuxCrashReport(dump: Minidump, entry: CrashDumpEntry): CrashReport | null {
  const thrown = dump.exception;
  if (!thrown || thrown.signal === SIMULATED_SIGNAL) return null;
  const process = PROCESS_KINDS[dump.annotations.ptype ?? "browser"] ?? "utility";
  const signal = SIGNALS[thrown.signal];
  const subtype = (signal && SIGNAL_CODES[signal]?.[thrown.code]) ?? GENERIC_CODES[thrown.code];
  const report: CrashReport = { incidentId: entry.id, time: dump.time, fileTime: entry.time, process, frames: dump.frames.map(frameOf), terminationNamespace: "SIGNAL" };
  if (signal) report.signal = signal;
  if (subtype) report.exceptionSubtype = subtype;
  if (process !== "browser" && dump.annotations.ver) report.engineVersion = dump.annotations.ver;
  const version = dump.annotations[VERSION_KEY];
  if (process === "browser" && version && APP_VERSION.test(version)) report.appVersion = version;
  if (dump.processStart !== null && dump.time >= dump.processStart) report.uptimeSeconds = Math.round((dump.time - dump.processStart) / 1000);
  const images = bundledImages(dump);
  if (images.length) report.images = images;
  return report;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function newestPerKind(reports: CrashReport[]): CrashReport[] {
  const sorted = [...reports].sort((a, b) => a.fileTime - b.fileTime);
  const browser = sorted.filter((report) => report.process === "browser").slice(-PER_PROCESS_KIND);
  const helpers = sorted.filter((report) => report.process !== "browser").slice(-PER_PROCESS_KIND);
  return [...browser, ...helpers].sort((a, b) => a.fileTime - b.fileTime);
}

export async function linuxCrashReports(host: ArdiaHost, since: number): Promise<CrashReport[]> {
  const listed = await invokeHost<CrashDumpEntry[]>("ArdiaCrash.list", { args: [since] }, host);
  const entries = (Array.isArray(listed) ? listed : [])
    .filter((entry) => typeof entry?.id === "string" && Number.isFinite(entry.time) && entry.time > since)
    .sort((a, b) => a.time - b.time)
    .slice(-READ_AT_MOST);
  const reports: CrashReport[] = [];
  for (const entry of entries) {
    const text = await invokeHost<string | null>("ArdiaCrash.read", { args: [entry.id] }, host).catch(() => null);
    if (typeof text !== "string" || !text) continue;
    let dump: Minidump | null = null;
    try { dump = parseMinidump(decodeBase64(text)); } catch { dump = null; }
    const report = dump && linuxCrashReport(dump, entry);
    if (report) reports.push(report);
  }
  return newestPerKind(reports);
}
