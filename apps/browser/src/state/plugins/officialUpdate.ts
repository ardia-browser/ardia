import { CONTRIBUTES_KEYS, isPluginPath, MENU_SLOTS, PERMISSION_KEYS, type MainSpec, type CommandSpec, type PluginContributions, type PluginManifest, type PluginPermissions, type ProgramSpec } from "../../lib/pluginManifest";
import { consentLines } from "./consent";

export const UPDATE_PROMPT_REASONS = ["baseline", "permissions", "network", "runtime", "activation", "programs", "hooks", "settings", "contributions", "unknown"] as const;
export type UpdatePromptReason = (typeof UPDATE_PROMPT_REASONS)[number];
export type UpdateVerdict = { ok: true; added: string[]; runtime: boolean } | { ok: false; reason: UpdatePromptReason };

type Both = { approved: PluginManifest; next: PluginManifest; fallbackExample: string | null };
type Rule<T> = (approved: T, next: T, both: Both) => UpdatePromptReason | null;


function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return `#${value}`;
  if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return `#${typeof value}`;
  return JSON.stringify(value);
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

const identical =
  (reason: UpdatePromptReason): Rule<unknown> =>
  (a, b) =>
    same(a, b) ? null : reason;

const cosmetic: Rule<unknown> = () => null;

const permissionsSame: Rule<PluginPermissions> = (a, b) => {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (!(PERMISSION_KEYS as readonly string[]).includes(key)) return "unknown";
  const hosts = (p: PluginPermissions) => (Array.isArray(p.network) ? [...p.network].sort() : p.network);
  if (!same(hosts(a), hosts(b))) return "network";
  return same({ ...a, network: null }, { ...b, network: null }) ? null : "permissions";
};

const MAIN_USES = PERMISSION_KEYS.filter((key) => key !== "control");

const grantsMainNothing = (p: PluginPermissions) => MAIN_USES.every((key) => p[key] === false);

const firstMain = ({ approved, next }: Both) => approved.main === null && next.main !== null;

const runs = (programs: readonly ProgramSpec[], fallbackExample: string | null) => ({
  programs: programs.map((p) => ({ name: p.name, path: p.path, afterUpdate: p.afterUpdate })),
  example: programs.find((p) => p.example)?.example ?? fallbackExample,
});

const programsWithin: Rule<ProgramSpec[]> = (a, b, { fallbackExample }) => (same(runs(a, fallbackExample), runs(b, fallbackExample)) ? null : "programs");

const isAddableCommand = (c: CommandSpec) => "view" in c.action || "handler" in c.action;

const commandsWithin: Rule<CommandSpec[]> = (a, b, both) => {
  for (const before of a) {
    const after = b.find((c) => c.name === before.name);
    if (!after || !same(before, after)) return "contributions";
  }
  for (const command of b) if (!a.some((c) => c.name === command.name) && (!isAddableCommand(command) || !firstMain(both))) return "contributions";
  const kept = b.filter((c) => a.some((x) => x.name === c.name));
  return same(kept.map((c) => c.name), a.map((c) => c.name)) ? null : "contributions";
};

const userOnly = (events: readonly string[]) => events.filter((e) => !e.startsWith("onCommand:")).sort();

const activationWithin: Rule<string[]> = (a, b, { approved, next }) => {
  if (!same(userOnly(a), userOnly(b))) return "activation";
  const added = b.filter((e) => e.startsWith("onCommand:") && !a.includes(e)).map((e) => e.slice("onCommand:".length));
  const addedCommands = next.commands.filter((c) => !approved.commands.some((x) => x.name === c.name)).map((c) => c.name);
  return added.every((name) => addedCommands.includes(name)) ? null : "activation";
};

const CONTRIBUTION_RULES: { [K in keyof PluginContributions]: Rule<PluginContributions[K]> } = {
  commands: commandsWithin,
  tools: identical("contributions"),
  hooks: identical("hooks"),
  settings: identical("settings"),
  programs: programsWithin,
  passwordManager: identical("contributions"),
  menus: identical("contributions"),
  toolbar: identical("contributions"),
  sidebarViews: identical("contributions"),
  panels: identical("contributions"),
  omnibox: identical("contributions"),
  themes: identical("contributions"),
  siteSwitches: identical("contributions"),
  pageBar: identical("contributions"),
};

const contributionsWithin: Rule<PluginContributions> = (a, b, both) => {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (!(CONTRIBUTES_KEYS as readonly string[]).includes(key) || !Object.hasOwn(CONTRIBUTION_RULES, key)) return "unknown";
  for (const key of CONTRIBUTES_KEYS) {
    const reason = (CONTRIBUTION_RULES[key] as Rule<unknown>)(a[key], b[key], both);
    if (reason) return reason;
  }
  return null;
};

function firstMainOnDemand(b: PluginManifest): boolean {
  const k = b.contributes;
  const elsewhere = b.page || k.panels.length || k.sidebarViews.length || k.toolbar.length || k.omnibox.length || k.tools.length || k.hooks.length || MENU_SLOTS.some((slot) => k.menus[slot].length);
  return !elsewhere && !b.sidecar && grantsMainNothing(b.permissions) && b.activationEvents.every((e) => e.startsWith("onCommand:"));
}

const isMainSpec = (m: unknown): boolean =>
  !!m && typeof m === "object" && Object.keys(m).sort().join() === "entry,memoryMB" && typeof (m as MainSpec).entry === "string" && isPluginPath((m as MainSpec).entry) && Number.isSafeInteger((m as MainSpec).memoryMB);

const mainWithin: Rule<PluginManifest["main"]> = (a, b, { approved, next }) => {
  if (a === null && b !== null) return !approved.sidecar && isMainSpec(b) && firstMainOnDemand(next) ? null : "runtime";
  return same(a, b) ? null : "runtime";
};

const MANIFEST_RULES: { [K in keyof PluginManifest]: Rule<PluginManifest[K]> } = {
  manifest: cosmetic,
  declaredManifest: cosmetic,
  name: (a, b) => (a === b ? null : "baseline"),
  official: (a, b) => (a === true && b === true ? null : "baseline"),
  title: cosmetic,
  description: cosmetic,
  version: cosmetic,
  requires: cosmetic,
  icon: cosmetic,
  keywords: cosmetic,
  telemetry: cosmetic,
  permissions: permissionsSame,
  main: mainWithin,
  sidecar: identical("runtime"),
  activationEvents: activationWithin,
  contributes: contributionsWithin,
  alwaysOn: identical("runtime"),
  autoInstall: identical("runtime"),
  settings: identical("settings"),
  commands: commandsWithin,
  tools: identical("contributions"),
  hooks: identical("hooks"),
  programs: programsWithin,
  passwordManager: identical("contributions"),
  page: identical("contributions"),
  process: identical("runtime"),
};

export function updateWithin(approved: PluginManifest, next: PluginManifest, fallbackExample: string | null = null): UpdateVerdict {
  try {
    return compare({ approved, next, fallbackExample });
  } catch {
    return { ok: false, reason: "unknown" };
  }
}

function compare(both: Both): UpdateVerdict {
  const { approved, next } = both;
  for (const key of new Set([...Object.keys(approved), ...Object.keys(next)])) if (!Object.hasOwn(MANIFEST_RULES, key)) return { ok: false, reason: "unknown" };
  for (const key of Object.keys(MANIFEST_RULES) as (keyof PluginManifest)[]) {
    const reason = (MANIFEST_RULES[key] as Rule<unknown>)(approved[key], next[key], both);
    if (reason) return { ok: false, reason };
  }
  const lines = (m: PluginManifest) => consentLines({ ...m, permissions: { ...m.permissions, network: Array.isArray(m.permissions.network) ? [...m.permissions.network].sort() : m.permissions.network } });
  const before = new Set(lines(approved).map((l) => l.text));
  return { ok: true, added: lines(next).map((l) => l.text).filter((text) => !before.has(text)), runtime: firstMain(both) };
}
