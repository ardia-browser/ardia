import { fileURLToPath } from "node:url";

const DRIVE = /(?<![A-Za-z0-9])([A-Za-z]):\//g;

export const toPosixPath = (path: string): string => path.replaceAll("\\", "/");

export const pathKey = (path: string): string => toPosixPath(path).replace(DRIVE, (drive) => drive.toLowerCase());

export const posixFilePath = (url: URL | string, windows?: boolean): string => toPosixPath(fileURLToPath(url, { windows }));

export const keyedPaths = <V>(entries: Iterable<readonly [string, V]>): Map<string, V> => new Map([...entries].map(([path, value]) => [pathKey(path), value]));

export const pathKeys = (paths: Iterable<string>): Set<string> => new Set([...paths].map(pathKey));

export const HOST_COMPONENT = /^[A-Za-z0-9._-]+$/;
export const HOST_COMPONENT_LIMIT = 128;
export const HOST_PATH_LIMIT = 512;
export const SANITIZED_NAME_LIMIT = 96;
const EXTENSION_LIMIT = 16;

export function hostServesPath(path: string): boolean {
  if (!path || path.length > HOST_PATH_LIMIT || path.startsWith("/") || path.includes("..")) return false;
  return path.split("/").every((part) => part !== "." && part.length <= HOST_COMPONENT_LIMIT && HOST_COMPONENT.test(part));
}

export const SANITIZED_PATH_LIMIT = HOST_PATH_LIMIT - 64;

const collapseDots = (text: string) => text.replace(/\.{2,}/g, ".");

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function safeComponent(part: string): string {
  const cleaned = collapseDots(part.replace(/[^A-Za-z0-9._-]/g, "-")).replace(/\.+$/, "");
  const unreserved = WINDOWS_RESERVED.test(cleaned) ? `-${cleaned}` : cleaned;
  const component = unreserved === "" || unreserved === "." ? "-" : unreserved;
  if (component.length <= SANITIZED_NAME_LIMIT) return component;
  const dot = component.lastIndexOf(".");
  const extension = dot > 0 && component.length - dot <= EXTENSION_LIMIT ? component.slice(dot) : "";
  const stem = component.slice(0, SANITIZED_NAME_LIMIT - extension.length).replace(/\.+$/, "") || "-";
  return collapseDots(stem + extension);
}

export function hostSafeFileName(name: string): string {
  const parts = name.split("/").map(safeComponent);
  while (parts.length > 1 && parts.join("/").length > SANITIZED_PATH_LIMIT) parts.shift();
  return parts.join("/");
}
