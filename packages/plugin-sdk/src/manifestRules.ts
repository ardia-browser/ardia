import type { ContributesV3 } from "./manifestContributes";
import type { PermissionsV3 } from "./manifestPermissions";
import { coveredBy } from "./matchPatterns";
import { at } from "./spec";

export type RuleInput = {
  id: string;
  scope: "global" | "profile";
  scopeGiven: boolean;
  main?: string;
  sidecar?: { run: string[]; memoryMB?: number };
  memoryMB?: number;
  activationEvents?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  permissions?: PermissionsV3;
  contributes?: ContributesV3;
};

function unique(problems: string[], path: string, names: readonly (string | undefined)[], what: string) {
  const seen = new Set<string>();
  for (const name of names) {
    if (name === undefined) continue;
    if (seen.has(name)) problems.push(`${path} has two ${what} named ${name}`);
    seen.add(name);
  }
}

export const needsGlobalScope = (m: Pick<RuleInput, "permissions" | "contributes">): boolean =>
  (m.contributes?.programs?.length ?? 0) > 0 || m.permissions?.control === true;

function permissionRules(problems: string[], p: PermissionsV3) {
  const tabs = p.tabs ?? false;
  if (p.fullUrls && !tabs) problems.push("permissions.fullUrls needs permissions.tabs");
  if (p.workspace && (tabs !== "write" || !p.fullUrls)) problems.push('permissions.workspace needs permissions.tabs: "write" and permissions.fullUrls');
  if (p.state && typeof p.state === "object") {
    for (const [i, event] of (p.state.events ?? []).entries()) {
      const where = at("permissions.state.events", i);
      if ((event === "tabs" || event === "workspace" || event === "navigation") && !tabs) problems.push(`${where}: ${event} events need permissions.tabs`);
      if (event === "downloads" && !p.downloads) problems.push(`${where}: downloads events need permissions.downloads`);
      if (event === "media" && !p.media) problems.push(`${where}: media events need permissions.media`);
      if (event === "profiles" && !p.profiles) problems.push(`${where}: profiles events need permissions.profiles`);
    }
    if ((p.state.intents ?? []).length && tabs !== "write") problems.push('permissions.state.intents need permissions.tabs: "write"');
  }
  if (p.activePage && typeof p.activePage === "object" && p.activePage.multiTab && !tabs) problems.push("permissions.activePage.multiTab needs permissions.tabs");
}

function coverage(problems: string[], path: string, matches: readonly string[], pages: readonly string[] | false | undefined) {
  matches.forEach((match, i) => {
    if (!Array.isArray(pages) || !coveredBy(pages, match)) problems.push(`${at(`${path}.matches`, i)}: ${match} isn't covered by permissions.pages`);
  });
}

function contributesRules(problems: string[], m: RuleInput, c: ContributesV3) {
  const P = "contributes";
  const commands = c.commands ?? [];
  const tools = c.tools ?? [];
  const panels = c.panels ?? [];
  const inputModes = c.inputModes ?? [];
  const rows = c.settings?.rows ?? [];
  unique(problems, `${P}.commands`, commands.map((x) => x.name), "commands");
  unique(problems, `${P}.tools`, tools.map((x) => x.name), "tools");
  unique(problems, `${P}.inputModes`, inputModes.map((x) => x.id), "input modes");
  unique(problems, `${P}.toolbar`, (c.toolbar ?? []).map((x) => x.id), "toolbar items");
  unique(problems, `${P}.sidebarViews`, (c.sidebarViews ?? []).map((x) => x.id), "sidebar views");
  unique(problems, `${P}.panels`, panels.map((x) => x.id), "panels");
  unique(problems, `${P}.omnibox`, (c.omnibox ?? []).map((x) => x.id), "omnibox providers");
  unique(problems, `${P}.pageStyles`, (c.pageStyles ?? []).map((x) => x.id), "page styles");
  unique(problems, `${P}.contentScripts`, (c.contentScripts ?? []).map((x) => x.id), "content scripts");
  unique(problems, `${P}.themes`, (c.themes ?? []).map((x) => x.id), "themes");
  unique(problems, `${P}.programs`, (c.programs ?? []).map((x) => x.name), "programs");
  unique(problems, `${P}.siteSwitches`, (c.siteSwitches ?? []).map((x) => x.key), "site switches");
  unique(problems, `${P}.settings.rows`, rows.map((x) => x.key), "rows");
  const commandNames = new Set(commands.map((x) => x.name));
  const rowOf = (key: string) => rows.find((r) => r.key === key);
  commands.forEach((command, i) => {
    const where = at(`${P}.commands`, i);
    if (command.tool && !tools.some((t) => t.name === command.tool)) problems.push(`${where}.tool: there's no tool named ${command.tool}`);
    if (command.panel && !panels.some((x) => x.id === command.panel)) problems.push(`${where}.panel: there's no panel named ${command.panel}`);
    if (command.inputMode && !inputModes.some((x) => x.id === command.inputMode)) problems.push(`${where}.inputMode: there's no input mode named ${command.inputMode}`);
    if (command.sideSetting && rowOf(command.sideSetting)?.type !== "choice") problems.push(`${where}.sideSetting: ${command.sideSetting} must be a choice row in contributes.settings.rows`);
    if (command.context && !m.permissions?.tabs) problems.push(`${where}.context needs permissions.tabs`);
    const actions = ["tool", "view", "panel", "open", "inputMode", "handler"].filter((k) => (command as Record<string, unknown>)[k] !== undefined);
    if (actions.length > 1) problems.push(`${where} must do one thing: it has ${actions.join(" and ")}`);
  });
  (c.toolbar ?? []).forEach((item, i) => {
    if (item.command && !commandNames.has(item.command)) problems.push(`${at(`${P}.toolbar`, i)}.command: there's no command named ${item.command}`);
    if (item.command && item.view) problems.push(`${at(`${P}.toolbar`, i)} has both command and view; pick one`);
  });
  for (const [slot, items] of Object.entries(c.menus ?? {})) {
    (items ?? []).forEach((item, i) => {
      if (!commandNames.has(item.command)) problems.push(`${at(`${P}.menus.${slot}`, i)}.command: there's no command named ${item.command}`);
    });
  }
  panels.forEach((panel, i) => {
    const where = at(`${P}.panels`, i);
    if (!panel.file === !panel.view) problems.push(`${where} needs exactly one of file and view`);
    if (panel.side && panel.mode !== "split") problems.push(`${where}.side only applies to split panels`);
  });
  (c.pageStyles ?? []).forEach((style, i) => coverage(problems, at(`${P}.pageStyles`, i), style.matches, m.permissions?.pages));
  (c.contentScripts ?? []).forEach((script, i) => coverage(problems, at(`${P}.contentScripts`, i), script.matches, m.permissions?.pages));
  if (c.pageBar) {
    const switches = new Set((c.siteSwitches ?? []).map((s) => s.key));
    if (!switches.has(c.pageBar.when.siteSwitch)) problems.push(`${P}.pageBar.when.siteSwitch: there's no site switch named ${c.pageBar.when.siteSwitch}`);
    const local = c.pageBar.when.localAddresses;
    if (local && rowOf(local)?.type !== "toggle") problems.push(`${P}.pageBar.when.localAddresses: ${local} must be a toggle row in contributes.settings.rows`);
  }
  rows.forEach((row, i) => {
    const where = at(`${P}.settings.rows`, i);
    if (row.type === "choice" && !row.choices) problems.push(`${where}.choices is required for a choice row`);
    if (row.type !== "choice" && row.choices) problems.push(`${where}.choices only applies to a choice row`);
    if (row.type === "toggle" && row.default !== undefined && typeof row.default !== "boolean") problems.push(`${where}.default must be true or false for a toggle row`);
    if (row.type === "number" && row.default !== undefined && typeof row.default !== "number") problems.push(`${where}.default must be a number for a number row`);
    if (row.type === "choice" && row.default !== undefined && !row.choices?.some((choice) => choice.value === row.default)) problems.push(`${where}.default must be one of its choices`);
  });
  if (c.passwordManager && !m.main && !m.sidecar) problems.push(`${P}.passwordManager needs main or sidecar`);
  const views = [
    ...commands.filter((x) => x.view).map(() => "command views"),
    ...(c.toolbar ?? []).filter((x) => x.view).map(() => "toolbar views"),
    ...panels.filter((x) => x.view).map(() => "panel views"),
    ...(c.sidebarViews?.length ? ["sidebarViews"] : []),
    ...(c.omnibox?.length ? ["omnibox"] : []),
    ...(inputModes.length ? ["inputModes"] : []),
  ];
  if (views.length && !m.main) problems.push(`${P}: ${[...new Set(views)].join(", ")} need main, which renders them`);
  const runtime = [...(tools.length ? ["tools"] : []), ...(c.hooks?.length ? ["hooks"] : []), ...(commands.some((x) => x.handler) ? ["handler commands"] : [])];
  if (runtime.length && !m.main && !m.sidecar) problems.push(`${P}: ${runtime.join(", ")} need main or sidecar`);
}

export function manifestRules(m: RuleInput): string[] {
  const problems: string[] = [];
  if (needsGlobalScope(m) && m.scopeGiven && m.scope !== "global") problems.push('scope must be "global" when the plugin declares contributes.programs or permissions.control');
  if (m.memoryMB !== undefined && !m.main) problems.push("memoryMB is main's memory limit; set sidecar.memoryMB for a sidecar");
  if (m.activationEvents?.length && !m.main && !m.sidecar) problems.push("activationEvents need main or sidecar");
  for (const field of ["dependencies", "optionalDependencies"] as const) {
    if (m[field] && Object.hasOwn(m[field], m.id)) problems.push(`${field}.${m.id}: a plugin can't depend on itself`);
  }
  for (const id of Object.keys(m.dependencies ?? {})) {
    if (Object.hasOwn(m.optionalDependencies ?? {}, id)) problems.push(`optionalDependencies.${id} is already in dependencies`);
  }
  if (m.permissions) permissionRules(problems, m.permissions);
  if (m.contributes) contributesRules(problems, m, m.contributes);
  return problems;
}
