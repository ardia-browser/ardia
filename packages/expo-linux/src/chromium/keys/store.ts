import { DEBUG_BUILD } from "../build";
import { COMMAND_ROWS, Row, SYSTEM_ROWS, type CommandRow } from "./commandTable";
import { MODIFIER_ORDER, Modifier, linuxComboFromStored, matches, modifierName, parseCombo, parseCombos, sameCombo, storedCombo, storedForm, type Combo, type KeyPress } from "./combos";

type MenuEntryValue = { id: string; title: string; current?: boolean };

export type CommandEntry = {
  id: string;
  command: string;
  arg: string | null;
  title: string;
  path: string[];
  flags: number;
  listed: boolean;
  pairs: [Combo | null, Combo | null][];
  defaults: Combo[];
  active: Combo[];
};

const PROFILE_SHORTCUT_COUNT = 9;

const pathOf = (path: string) => (path ? path.split(" > ") : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const entries = (value: unknown): MenuEntryValue[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .map((item) => ({ id: String(item.id ?? ""), title: String(item.title ?? ""), current: item.current === true }))
    : [];

function entryFromRow(row: CommandRow): CommandEntry {
  const colon = row.id.indexOf(":");
  const standard = row.id.startsWith("std:");
  const macCombos = parseCombos(row.mac);
  const linuxCombos = parseCombos(row.linux);
  return {
    id: row.id,
    command: !standard && colon >= 0 ? row.id.slice(0, colon) : row.id,
    arg: !standard && colon >= 0 ? row.id.slice(colon + 1) : null,
    title: row.title,
    path: pathOf(row.path),
    flags: row.flags ?? 0,
    listed: true,
    pairs: macCombos.map((mac, i) => [mac, linuxCombos[i] ?? null]),
    defaults: linuxCombos.filter((combo): combo is Combo => !!combo),
    active: [],
  };
}

function dynamicEntry(command: string, arg: string, title: string, path: string, pairs: [Combo, Combo][], defaults: Combo[], listed: boolean): CommandEntry {
  return { id: `${command}:${arg}`, command, arg, title, path: pathOf(path), flags: 0, listed, pairs, defaults, active: [] };
}

class MenuStore {
  checked = new Set<string>();
  disabled = new Set<string>();
  titles: Record<string, string> = {};
  profiles: MenuEntryValue[] = [];
  windows: MenuEntryValue[] = [];
  recentlyClosed: MenuEntryValue[] = [];
  recentlyClosedGroups: MenuEntryValue[] = [];
  extensions: { id: string; title: string }[] = [];
  shortcuts: Record<string, string[][]> = {};
  bookmarks: Record<string, unknown> = {};
  warnBeforeQuitting = false;
  warnBeforeClosingWindow = false;
  undoReopensClosedTab = false;
  bookmarksShown = true;
  downloadsInProgress = 0;
  fromApp = false;
  entries: CommandEntry[] = [];

  constructor() {
    this.rebuild();
  }

  update(state: Record<string, unknown>): void {
    this.checked = new Set(strings(state.checked));
    this.disabled = new Set(strings(state.disabled));
    this.titles = {};
    if (state.titles && typeof state.titles === "object")
      for (const [key, value] of Object.entries(state.titles)) if (typeof value === "string") this.titles[key] = value;
    this.profiles = entries(state.profiles);
    this.windows = entries(state.windows);
    this.recentlyClosed = entries(state.recentlyClosed);
    this.recentlyClosedGroups = entries(state.recentlyClosedGroups);
    this.warnBeforeQuitting = state.warnBeforeQuitting === true;
    this.warnBeforeClosingWindow = state.warnBeforeClosingWindow === true;
    this.undoReopensClosedTab = state.undoReopensClosedTab === true;
    this.bookmarksShown = state.bookmarksShown !== false;
    this.downloadsInProgress = typeof state.downloadsInProgress === "number" ? state.downloadsInProgress : 0;
    this.extensions = entries(state.extensions).map(({ id, title }) => ({ id, title }));
    this.shortcuts = {};
    if (state.shortcuts && typeof state.shortcuts === "object")
      for (const [id, list] of Object.entries(state.shortcuts)) this.shortcuts[id] = Array.isArray(list) ? list.map(strings) : [];
    this.fromApp = true;
    this.rebuild();
  }

  updateBookmarks(lists: Record<string, unknown>): void {
    this.bookmarks = lists ?? {};
  }

  isDisabled = (key: string) => this.disabled.has(key);
  entryEnabled = (entry: CommandEntry) => !this.isDisabled(entry.id) && !this.isDisabled(entry.command);

  entryHidden(entry: CommandEntry): boolean {
    if (entry.flags & Row.Hidden) return true;
    if (entry.flags & Row.HiddenWithBookmarks && !this.bookmarksShown) return true;
    return !!(entry.flags & Row.HiddenWhenDisabled) && !this.entryEnabled(entry);
  }

  entryReachable = (entry: CommandEntry) => !(entry.flags & (Row.HiddenWithBookmarks | Row.InBookmarksMenu)) || this.bookmarksShown;

  rebuild(): void {
    const built: CommandEntry[] = [];
    for (const row of COMMAND_ROWS) {
      if (!DEBUG_BUILD && (row.flags ?? 0) & Row.DebugOnly) continue;
      if (!row.expansion) built.push(entryFromRow(row));
      else if (row.expansion === "LittleArdiaProfiles")
        for (const profile of this.profiles) built.push(dynamicEntry("newLittleArdia", profile.id, profile.title, row.path, [], [], true));
      else if (row.expansion === "SwitchProfiles")
        this.profiles.forEach((profile, i) => {
          const primary: [Combo, Combo][] = [];
          const alternate: [Combo, Combo][] = [];
          if (i < PROFILE_SHORTCUT_COUNT) {
            const digit = String(i + 1);
            primary.push([{ key: digit, modifiers: Modifier.Control }, { key: digit, modifiers: Modifier.Option }]);
            alternate.push([{ key: digit, modifiers: Modifier.Control | Modifier.Command }, { key: digit, modifiers: Modifier.Control | Modifier.Option }]);
          }
          built.push(dynamicEntry("switchProfile", profile.id, profile.title, row.path, primary, primary.map((pair) => pair[1]), true));
          built.push(dynamicEntry("newWindow", profile.id, `${profile.title} ↗`, row.path, alternate, [], false));
        });
      else for (const extension of this.extensions) built.push(dynamicEntry("openExtension", extension.id, extension.title, row.path, [], [], true));
    }
    this.entries = built;
    this.applyShortcuts();
  }

  applyShortcuts(): void {
    for (const entry of this.entries) {
      const stored = this.shortcuts[entry.id];
      if (!stored) {
        entry.active = entry.defaults;
        continue;
      }
      const unique: Combo[] = [];
      for (const combo of stored) {
        const literal = linuxComboFromStored(storedCombo(combo));
        if (literal && !unique.some((known) => sameCombo(known, literal))) unique.push(literal);
      }
      entry.active = unique;
    }
  }

  linuxComboForMac(stored: Combo): Combo | null {
    for (const entry of this.entries) for (const [mac, linux] of entry.pairs) if (sameCombo(mac, stored)) return linux;
    return null;
  }

  match(press: KeyPress): CommandEntry | null {
    for (const entry of this.entries) {
      if (!this.entryReachable(entry)) continue;
      if (entry.active.some((combo) => matches(combo, press))) return entry;
    }
    return null;
  }

  find = (id: string) => this.entries.find((entry) => entry.id === id) ?? null;

  activeBindings(): Record<string, string[][]> {
    const bindings: Record<string, string[][]> = {};
    for (const entry of this.entries) if (!(entry.id in bindings)) bindings[entry.id] = entry.active.map(storedForm);
    return bindings;
  }

  shortcutList() {
    const order: string[] = [];
    const primaries = new Map<string, CommandEntry>();
    for (const entry of this.entries) {
      if (!entry.listed || !entry.title) continue;
      const known = primaries.get(entry.id);
      if (!known) {
        order.push(entry.id);
        primaries.set(entry.id, entry);
      } else if (this.entryHidden(known) && !this.entryHidden(entry)) primaries.set(entry.id, entry);
    }
    const list: Record<string, unknown>[] = order.map((id) => {
      const entry = primaries.get(id)!;
      return { id, title: entry.title, path: entry.path, remappable: true };
    });
    for (const row of SYSTEM_ROWS) {
      const combo = parseCombo(row.linux);
      if (!combo) continue;
      list.push({
        id: `system:${row.path} > ${row.title}`,
        title: row.title,
        path: pathOf(row.path),
        remappable: false,
        key: combo.key,
        modifiers: MODIFIER_ORDER.filter((modifier) => combo.modifiers & modifier).map(modifierName),
      });
    }
    return list;
  }
}

export const menuStore = new MenuStore();
