import type { WindowsUpdateVerifyFailure } from "./counts";

export type Installer = { url: string; sha256: string; bytes: number };
export type UpdateManifest = { version: string; build: number; installers: Partial<Record<Cpu, Installer>> };
export type BuildIdentity = { version: string; build: number };
type Cpu = "x64" | "arm64";

export type VerifiedUpdateResult =
  | { status: "ok"; version: string; build: number; installer: Installer }
  | { status: "upToDate" }
  | { status: "notPublished" }
  | { status: "failed"; reason: WindowsUpdateVerifyFailure; message: string };

const CPUS: Cpu[] = ["x64", "arm64"];
const LARGEST_MANIFEST_BYTES = 64 * 1024;
const LARGEST_INSTALLER_BYTES = 2 ** 30;
const LARGEST_URL_BYTES = 512;
const LARGEST_PREFIX_BYTES = 256;
const LOCAL_HTTP_HOSTS = new Set(["127.0.0.1", "localhost", "10.0.2.2"]);
const KNOWN_FAILURES = new Set<string>(["signature", "manifest", "tooLarge", "missing", "network", "verifier", "other"]);
const TOP_KEYS = new Set(["version", "build", "x64", "arm64"]);
const INSTALLER_KEYS = new Set(["url", "sha256", "bytes"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isBuild = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isVersion = (value: unknown): value is string => typeof value === "string" && /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(value);
const hasValidPath = (text: string) => /^[0-9A-Za-z._+/-]*$/.test(text) && !text.includes("..") && !text.includes("//") && !text.split("/").includes(".");

export function isValidPublishedUnder(prefix: string): boolean {
  if (typeof prefix !== "string" || prefix.length === 0 || prefix.length > LARGEST_PREFIX_BYTES || !prefix.endsWith("/")) return false;
  let isHttp = false;
  let rest: string;
  if (prefix.startsWith("https://")) rest = prefix.slice(8);
  else if (prefix.startsWith("http://")) {
    isHttp = true;
    rest = prefix.slice(7);
  } else return false;
  const slash = rest.indexOf("/");
  if (slash <= 0) return false;
  const authority = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (path.startsWith("/") || !hasValidPath(path)) return false;
  const colon = authority.indexOf(":");
  const host = colon >= 0 ? authority.slice(0, colon) : authority;
  if (colon >= 0) {
    const port = authority.slice(colon + 1);
    if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) return false;
  }
  if (!host || host.startsWith(".") || host.endsWith(".") || !/^[0-9A-Za-z.-]+$/.test(host)) return false;
  return !isHttp || LOCAL_HTTP_HOSTS.has(host);
}

function isValidInstallerUrl(url: unknown, publishedUnder: string): url is string {
  if (typeof url !== "string" || url.length > LARGEST_URL_BYTES || !url.startsWith(publishedUnder)) return false;
  const rest = url.slice(publishedUnder.length);
  if (!rest || rest.startsWith("/") || !hasValidPath(rest) || !rest.endsWith(".exe")) return false;
  const stemPath = rest.slice(0, -4);
  const slash = stemPath.lastIndexOf("/");
  const stem = slash >= 0 ? stemPath.slice(slash + 1) : stemPath;
  return /^[0-9A-Za-z]/.test(stem);
}

function parsed(text: string): Record<string, unknown> | null {
  if (typeof text !== "string" || text.length === 0 || text.length > LARGEST_MANIFEST_BYTES || text.includes("\\") || text.charCodeAt(0) === 0xfeff) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function hasDuplicateKeys(text: string): boolean {
  let pos = 0;
  const skipWs = () => {
    while (pos < text.length && (text[pos] === " " || text[pos] === "\t" || text[pos] === "\n" || text[pos] === "\r")) pos += 1;
  };
  const readString = (): string | null => {
    if (text[pos] !== '"') return null;
    pos += 1;
    const start = pos;
    while (pos < text.length && text[pos] !== '"') {
      if (text[pos] === "\\") return null;
      pos += 1;
    }
    if (pos >= text.length) return null;
    const out = text.slice(start, pos);
    pos += 1;
    return out;
  };
  const walkValue = (): boolean => {
    skipWs();
    if (pos >= text.length) return false;
    const ch = text[pos];
    if (ch === "{") return walkObject();
    if (ch === '"') return readString() !== null;
    if (ch === "[") {
      pos += 1;
      skipWs();
      if (text[pos] === "]") {
        pos += 1;
        return true;
      }
      while (pos < text.length) {
        if (!walkValue()) return false;
        skipWs();
        if (text[pos] === ",") pos += 1;
        else if (text[pos] === "]") {
          pos += 1;
          return true;
        } else return false;
      }
      return false;
    }
    const start = pos;
    while (pos < text.length && !/[\s,}\]]/.test(text[pos] ?? "")) pos += 1;
    return /^(?:0|[1-9][0-9]*)$/.test(text.slice(start, pos));
  };
  const walkObject = (): boolean => {
    pos += 1;
    skipWs();
    const seen = new Set<string>();
    if (text[pos] === "}") {
      pos += 1;
      return true;
    }
    while (pos < text.length) {
      skipWs();
      const key = readString();
      if (key === null || seen.has(key)) return false;
      seen.add(key);
      skipWs();
      if (text[pos] !== ":") return false;
      pos += 1;
      if (!walkValue()) return false;
      skipWs();
      if (text[pos] === ",") pos += 1;
      else if (text[pos] === "}") {
        pos += 1;
        return true;
      } else return false;
    }
    return false;
  };
  skipWs();
  if (text[pos] !== "{") return true;
  if (!walkObject()) return true;
  skipWs();
  return pos !== text.length;
}

function readInstaller(value: unknown, publishedUnder: string): Installer | null {
  if (!isRecord(value)) return null;
  for (const key of Object.keys(value)) if (!INSTALLER_KEYS.has(key)) return null;
  const { url, sha256, bytes } = value;
  if (!isValidInstallerUrl(url, publishedUnder)) return null;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > LARGEST_INSTALLER_BYTES) return null;
  return { url, sha256, bytes };
}

export function readBuild(text: string): BuildIdentity | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 4096) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || !isVersion(value.version) || !isBuild(value.build)) return null;
    return { version: value.version, build: value.build };
  } catch {
    return null;
  }
}

export function readManifest(text: string, publishedUnder: string): UpdateManifest | null {
  if (!isValidPublishedUnder(publishedUnder)) return null;
  const value = parsed(text);
  if (!value || hasDuplicateKeys(text)) return null;
  for (const key of Object.keys(value)) if (!TOP_KEYS.has(key)) return null;
  if (!isVersion(value.version) || !isBuild(value.build)) return null;
  const installers: Partial<Record<Cpu, Installer>> = {};
  for (const cpu of CPUS) {
    if (!Object.hasOwn(value, cpu)) continue;
    const installer = readInstaller(value[cpu], publishedUnder);
    if (!installer) return null;
    installers[cpu] = installer;
  }
  return { version: value.version, build: value.build, installers };
}

export function offered(manifest: UpdateManifest, cpu: string, current: number): Installer | null {
  if (manifest.build <= current) return null;
  return (cpu === "x64" || cpu === "arm64" ? manifest.installers[cpu] : undefined) ?? null;
}

export function parseVerifiedUpdate(text: string, publishedUnder: string, currentBuild: number): VerifiedUpdateResult {
  if (!isValidPublishedUnder(publishedUnder) || !Number.isSafeInteger(currentBuild) || currentBuild < 0) {
    return { status: "failed", reason: "verifier", message: "the update check parameters are invalid" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { status: "failed", reason: "verifier", message: "the update verifier returned an unreadable answer" };
  }
  if (!isRecord(value) || typeof value.status !== "string") {
    return { status: "failed", reason: "verifier", message: "the update verifier returned an unreadable answer" };
  }
  if (value.status === "notPublished") return { status: "notPublished" };
  if (value.status === "upToDate") return { status: "upToDate" };
  if (value.status === "ok") {
    if (!isVersion(value.version) || !isBuild(value.build) || value.build <= currentBuild) {
      return { status: "failed", reason: "manifest", message: "the update feed could not be read" };
    }
    const installer = readInstaller({ url: value.url, sha256: value.sha256, bytes: value.bytes }, publishedUnder);
    if (!installer) {
      return { status: "failed", reason: "manifest", message: "the update feed could not be read" };
    }
    return { status: "ok", version: value.version, build: value.build, installer };
  }
  if (value.status === "failed") {
    const rawReason = typeof value.reason === "string" ? value.reason : "other";
    if (rawReason === "notNewer" || rawReason === "kind") return { status: "upToDate" };
    const reason: WindowsUpdateVerifyFailure = KNOWN_FAILURES.has(rawReason) ? (rawReason as WindowsUpdateVerifyFailure) : "other";
    const message = typeof value.message === "string" && value.message.length > 0 && value.message.length <= 200 ? value.message : "the update check failed";
    return { status: "failed", reason, message };
  }
  return { status: "failed", reason: "verifier", message: "the update verifier returned an unreadable answer" };
}

export function failureText(error: unknown): string {
  if (typeof error === "string" && error) return error;
  if (typeof error === "object" && error !== null) {
    const { message } = error as { message?: unknown };
    if (typeof message === "string" && message) return message;
  }
  return "the check failed";
}

export const feedNotPublished = (error: unknown) => /\banswered 404\b/.test(failureText(error));

export const folderOf = (address: string) => address.slice(0, address.lastIndexOf("/") + 1);

export const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / (1024 * 1024)));
