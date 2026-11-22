import { isFields, type Fields } from "./decode";
import type { Migrations } from "./savedDocument";
import { legacyPermissions } from "./pluginPermissions";
import { PAGE_PANEL_ID } from "./pluginContributions";

const MOVED_INTO_CONTRIBUTES = ["commands", "tools", "hooks", "settings", "programs", "passwordManager"] as const;

function pageAsPanel(page: unknown): unknown {
  return isFields(page) ? { id: PAGE_PANEL_ID, mode: "tab", ...page } : page;
}

export function contributesFromV1(doc: Fields): Fields {
  if (Object.hasOwn(doc, "contributes") || Object.hasOwn(doc, "sidecar") || Object.hasOwn(doc, "main")) return doc;
  const { permissions, process, page, ...rest } = doc;
  const contributes: Fields = {};
  for (const key of MOVED_INTO_CONTRIBUTES) {
    if (rest[key] === undefined) continue;
    contributes[key] = rest[key];
    delete rest[key];
  }
  if (page !== undefined) contributes.panels = [pageAsPanel(page)];
  return {
    ...rest,
    ...(permissions !== undefined ? { permissions: legacyPermissions(permissions) } : {}),
    ...(process !== undefined ? { sidecar: process } : {}),
    contributes,
  };
}

export const MANIFEST_MIGRATIONS: Migrations = {
  0: (doc) => {
    const { settings, reset: _reset, ...rest } = doc;
    return settings === undefined ? rest : { ...rest, settings: { defaults: settings } };
  },
  1: contributesFromV1,
};

const V1_PATHS: [RegExp, string][] = [
  [/contributes\.panels\[0\]/g, "page"],
  [/contributes\./g, ""],
  [/^sidecar\b/, "process"],
  [/ needs a main or a sidecar$/, " needs a process"],
];

export const v1Problem = (problem: string): string => V1_PATHS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), problem);
