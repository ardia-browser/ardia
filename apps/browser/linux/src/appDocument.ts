import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hostEnvironment } from "./paths";

export const appDocumentUrl = (): string =>
  hostEnvironment.devServer ?? pathToFileURL(join(hostEnvironment.uiDirectory ?? join(__dirname, "../ui"), "index.html")).href;

export function isAppDocument(url: string): boolean {
  try {
    const candidate = new URL(url);
    const app = new URL(appDocumentUrl());
    if (app.protocol === "file:") return candidate.protocol === "file:" && candidate.host === app.host && candidate.pathname === app.pathname;
    return candidate.origin === app.origin;
  } catch {
    return false;
  }
}
