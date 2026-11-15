import { configDirectory } from "../../platform/launchConfig";
import { onConfigChange, readConfigFile, watchConfigFiles, writeConfigSchemas, type ConfigFileRead } from "../../platform/configFolder";
import { afterFirstWindow } from "../../lib/afterFirstWindow";
import { mergedPalettes, parseThemeFile, type RolePalettes, type ThemeRoles } from "../../lib/themeFile";
import { DEFAULT_LOOK, resolveLook, withSidebarText, type LookBlocks, type SidebarTextSize } from "../../lib/themeLook";
import { setActiveLook } from "../../lib/activeLook";
import { withoutOutlines } from "./elementOutlines";
import { withTabCorners } from "../../lib/tabCorners";
import { minimalismLookOf } from "../../lib/minimalismLook";
import { useBrowser } from "../browser/store";
import { hideKeyedToast, showToast, useToasts } from "../app/toasts";
import { focusedWindowOf } from "../windows/ui";
import { useBasePalette } from "./basePalette";
import { CONFIG_FILE, launchRestoreSession, readConfig } from "./configSettings";
import { schemaFiles } from "./configSchema";
import { reloadHooks } from "../automation/hookRules";
import { noteConfigProblemToastDismissed, noteConfigProblemToastShown } from "../telemetry/configProblemToasts";

const RECONCILE_DELAY_MS = 100;
const PROBLEMS_TOAST = "config-problems";
const PROBLEMS_SHOWN = 2;
const UNKNOWN_KEY = /^(.*?)([^\s:]+) isn't an? (.+) key \((.+)\)$/;

const READ_PROBLEMS: Record<Exclude<ConfigFileRead["status"], "ok" | "missing">, string> = {
  notFile: "isn't a regular file",
  tooBig: "is over 1 MB",
  unreadable: "can't be read",
};

type ThemeParts = { roles: ThemeRoles | null; look: LookBlocks | null };
type Theme = ThemeParts & { name: string | null };

const NO_THEME: ThemeParts = { roles: null, look: null };

let defaults: RolePalettes | null = null;
let theme: Theme = { name: null, ...NO_THEME };
let appliedSidebarText: SidebarTextSize = "default";
let stopWatchingSidebarText: (() => void) | null = null;
let revision = 0;
let outlines = true;
let tabCorners: number | null = null;
let minimalism = false;
let stopWatchingMinimalism: (() => void) | undefined;
let windowsUp = false;
let reported = new Set<string>();
let pendingProblems = false;
let unsubscribers: (() => void)[] = [];
let watching: string | null | undefined;
let schemas: Record<string, string> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const lastGoodThemes = new Map<string, ThemeParts>();

const themeFile = (name: string) => `themes/${name}.json`;

function readTheme(name: string | null, problems: string[]): ThemeParts {
  if (!name || !defaults) return NO_THEME;
  const file = themeFile(name);
  const read = readConfigFile(file);
  if (read.status === "missing") {
    problems.push(`${CONFIG_FILE}: theme ${name} has no file ${file}`);
    return NO_THEME;
  }
  if (read.status !== "ok") {
    problems.push(`${file}: ${READ_PROBLEMS[read.status]}`);
    return lastGoodThemes.get(name) ?? NO_THEME;
  }
  const parsed = parseThemeFile(file, read.text, defaults);
  problems.push(...parsed.problems);
  if (!parsed.roles) return lastGoodThemes.get(name) ?? NO_THEME;
  const parts = { roles: parsed.roles, look: parsed.look };
  lastGoodThemes.set(name, parts);
  return parts;
}

function applySidebarWidth(before: number | null, after: number | null) {
  if (!windowsUp || after === null || after === before) return;
  const width = Math.round(after);
  if (useBrowser.getState().settings.sidebarWidth !== width) useBrowser.getState().updateSettings({ sidebarWidth: width });
}

const sidebarTextSize = () => useBrowser.getState().settings.sidebarTextSize;

function applyTheme(next: Theme) {
  if (!defaults) return;
  const size = sidebarTextSize();
  const minimal = useBrowser.getState().settings.minimalismMode;
  const outlined = useBrowser.getState().settings.elementOutlines;
  const corners = useBrowser.getState().settings.tabCornerRadius;
  if (next.name === theme.name && size === appliedSidebarText && minimal === minimalism && outlined === outlines && corners === tabCorners && JSON.stringify([next.roles, next.look]) === JSON.stringify([theme.roles, theme.look])) return;
  const before = useBasePalette.getState().look;
  const resolved = resolveLook(next.look);
  const look = withTabCorners(withSidebarText(minimal ? minimalismLookOf(resolved) : resolved, size), corners);
  theme = next;
  appliedSidebarText = size;
  minimalism = minimal;
  outlines = outlined;
  tabCorners = corners;
  revision += 1;
  setActiveLook(look);
  const roles = outlined ? next.roles : withoutOutlines(next.roles);
  const themed = roles || look !== DEFAULT_LOOK;
  useBasePalette.setState({ palette: themed ? mergedPalettes(defaults, roles, revision) : null, theme: next.name, look, blocks: next.look });
  applySidebarWidth(before.sidebarWidth, look.sidebarWidth);
}

const fileOf = (problem: string) => problem.slice(0, Math.max(problem.indexOf(": "), 0));

function spokenList(items: readonly string[]): string {
  return items.length === 1 ? items[0]! : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function groupedUnknownKeys(lines: readonly string[]): string[] {
  const groups = new Map<string, { at: number; prefix: string; keys: string[]; noun: string; known: string }>();
  const out: (string | null)[] = [];
  for (const line of lines) {
    const match = UNKNOWN_KEY.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }
    const [, prefix, key, noun, known] = match as unknown as [string, string, string, string, string];
    const id = `${prefix}\u0000${noun}\u0000${known}`;
    const group = groups.get(id);
    if (group) group.keys.push(key);
    else groups.set(id, { at: out.push(null) - 1, prefix, keys: [key], noun, known });
  }
  for (const { at, prefix, keys, noun, known } of groups.values()) {
    const article = /^[aeiou]/.test(noun) ? "an" : "a";
    out[at] = `${prefix}${spokenList(keys)} ${keys.length === 1 ? `isn't ${article} ${noun} key` : `aren't ${noun} keys`} (${known})`;
  }
  return out.filter((line): line is string => line !== null);
}

export function problemsToast(problems: readonly string[]): { title: string; message: string } {
  const files = new Set(problems.map(fileOf));
  const file = files.size === 1 ? [...files][0]! : "";
  const count = problems.length === 1 ? "a problem" : `${problems.length} problems`;
  const title = file ? `${file} has ${count}` : `Your config files have ${count}`;
  const lines = groupedUnknownKeys(problems.map((problem) => (file ? problem.slice(file.length + 2) : problem)));
  const rest = lines.length - PROBLEMS_SHOWN;
  const shown = lines.slice(0, PROBLEMS_SHOWN).join("; ");
  return { title, message: rest > 0 ? `${shown}; and ${rest} more (ardia config check lists them all)` : shown };
}

function showProblems() {
  if (!windowsUp) return;
  const toasts = useToasts.getState().toasts;
  const showing = Object.keys(toasts).filter((id) => toasts[id]?.key === PROBLEMS_TOAST);
  if (!reported.size) {
    pendingProblems = false;
    for (const id of showing) hideKeyedToast(id, PROBLEMS_TOAST);
    return;
  }
  const state = useBrowser.getState();
  const windowId = pendingProblems ? (focusedWindowOf(state) ?? state.windowOrder[0]) : showing[0];
  if (!windowId) return;
  const occupant = toasts[windowId];
  if (occupant && occupant.key !== PROBLEMS_TOAST) return;
  pendingProblems = false;
  for (const id of showing) if (id !== windowId) hideKeyedToast(id, PROBLEMS_TOAST);
  if (!occupant) noteConfigProblemToastShown();
  const { title, message } = problemsToast([...reported]);
  showToast(windowId, title, message, { icon: "exclamationmark.triangle", key: PROBLEMS_TOAST, sticky: true, action: { title: "Dismiss", run: noteConfigProblemToastDismissed } });
}

function toastsChanged(next: ReturnType<typeof useToasts.getState>, previous: ReturnType<typeof useToasts.getState>) {
  if (!reported.size) return;
  for (const [id, toast] of Object.entries(previous.toasts)) {
    const now = next.toasts[id];
    if (toast?.key === PROBLEMS_TOAST && now && now.key !== PROBLEMS_TOAST) pendingProblems = true;
  }
  if (pendingProblems) showProblems();
}

function windowsChanged() {
  if (pendingProblems && reported.size) showProblems();
}

function report(problems: string[]) {
  const now = new Set(problems);
  const fresh = [...now].filter((p) => !reported.has(p));
  const changed = fresh.length > 0 || now.size !== reported.size;
  reported = now;
  for (const problem of fresh) console.warn(`[config] ${problem} (${configDirectory()})`);
  if (fresh.length) pendingProblems = true;
  if (changed) showProblems();
}

function watchNames() {
  if (theme.name === watching) return;
  watching = theme.name;
  watchConfigFiles(["config.json", "hooks.json", ...(theme.name ? [themeFile(theme.name)] : [])]).then(changed, (error: unknown) => console.warn("[config] couldn't watch the config folder", error));
}

export function reconcileConfig() {
  const problems: string[] = [];
  const read = readConfigFile(CONFIG_FILE);
  let name = theme.name;
  if (read.status === "missing") name = null;
  else if (read.status !== "ok") problems.push(`${CONFIG_FILE}: ${READ_PROBLEMS[read.status]}`);
  else {
    const config = readConfig(read.text, useBrowser.getState().settings);
    problems.push(...config.problems);
    if (Object.keys(config.patch).length) useBrowser.getState().updateSettings(config.patch);
    if (config.theme !== undefined) name = config.theme;
  }
  applyTheme({ name, ...readTheme(name, problems) });
  report(problems);
  if (watching !== undefined) watchNames();
}

function writeSchemas() {
  if (!defaults) return;
  schemas ??= schemaFiles(defaults);
  writeConfigSchemas(schemas).catch((error: unknown) => console.warn("[config] couldn't write the schemas", error));
}

function changed() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    reconcileConfig();
    reloadHooks();
    writeSchemas();
  }, RECONCILE_DELAY_MS);
}

export function configRestoreSession(): boolean | undefined {
  const read = readConfigFile(CONFIG_FILE);
  return read.status === "ok" ? launchRestoreSession(read.text, useBrowser.getState().settings) : undefined;
}

export function startConfigFiles(roles: RolePalettes) {
  if (defaults) return;
  defaults = roles;
  reconcileConfig();
  stopWatchingSidebarText = useBrowser.subscribe((s, prev) => {
    if (s.settings.sidebarTextSize !== prev.settings.sidebarTextSize) applyTheme(theme);
  });
  unsubscribers.push(useBrowser.subscribe((s, prev) => s.settings.elementOutlines !== prev.settings.elementOutlines && applyTheme(theme)));
  unsubscribers.push(useBrowser.subscribe((s, prev) => s.settings.tabCornerRadius !== prev.settings.tabCornerRadius && applyTheme(theme)));
  stopWatchingMinimalism = useBrowser.subscribe((s, prev) => {
    if (s.settings.minimalismMode !== prev.settings.minimalismMode) applyTheme(theme);
  });
  afterFirstWindow(() => {
    windowsUp = true;
    onConfigChange(changed);
    watchNames();
    writeSchemas();
    unsubscribers.push(useToasts.subscribe(toastsChanged), useBrowser.subscribe((next, previous) => next.windowOrder !== previous.windowOrder && windowsChanged()));
    showProblems();
  });
}

export function resetConfigFilesForTests() {
  clearTimeout(timer);
  stopWatchingMinimalism?.();
  stopWatchingMinimalism = undefined;
  minimalism = false;
  outlines = true;
  tabCorners = null;
  timer = undefined;
  defaults = null;
  theme = { name: null, ...NO_THEME };
  appliedSidebarText = "default";
  stopWatchingSidebarText?.();
  stopWatchingSidebarText = null;
  windowsUp = false;
  reported = new Set();
  pendingProblems = false;
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  watching = undefined;
  schemas = null;
  lastGoodThemes.clear();
  setActiveLook(DEFAULT_LOOK);
  useBasePalette.setState({ palette: null, theme: null, look: DEFAULT_LOOK, blocks: null });
}
