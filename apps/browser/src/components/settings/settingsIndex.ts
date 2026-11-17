import { prepare, type Searchable } from "./searchMatch";
import type { paneTints } from "./tokens";
import { SETTINGS_PANES, type SettingsPane } from "../../state/settings/settingsWindows";
import type { Settings } from "../../state/settings/settings";
import { advancedRows } from "./rows/advancedRows";
import { appearanceRows } from "./rows/appearanceRows";
import { automationRows } from "./rows/automationRows";
import { generalRows } from "./rows/generalRows";
import { profileRows } from "./rows/profileRows";
import { shortcutRows } from "./rows/shortcutRows";
import { tabRows } from "./rows/tabRows";
import type { SettingSection, SettingsEnv } from "./rows/types";

type PaneTint = Exclude<keyof typeof paneTints, "ink">;

const PANE_LOOKS: Record<SettingsPane, { title: string; icon: string; tint: PaneTint }> = {
  general: { title: "General", icon: "gearshape.fill", tint: "gray" },
  profiles: { title: "Profiles", icon: "person.2.fill", tint: "blue" },
  tabs: { title: "Tabs", icon: "square.on.square.fill", tint: "orange" },
  appearance: { title: "Appearance", icon: "circle.lefthalf.filled", tint: "indigo" },
  automations: { title: "Automations", icon: "wand.and.rays", tint: "purple" },
  shortcuts: { title: "Shortcuts", icon: "keyboard.fill", tint: "pink" },
  advanced: { title: "Advanced", icon: "slider.horizontal.3", tint: "gray" },
};

export const PANES: { id: SettingsPane; title: string; icon: string; tint: PaneTint }[] = SETTINGS_PANES.map((id) => ({ id, ...PANE_LOOKS[id] }));

const ROWS = { ...generalRows, ...profileRows, ...tabRows, ...appearanceRows, ...automationRows, ...shortcutRows, ...advancedRows };
const SECTIONS = ROWS as unknown as Record<SettingsPane, SettingSection[]>;

type RowKeysOf<P extends SettingsPane> = (typeof ROWS)[P][number] extends infer S ? (S extends { rows: infer R } ? keyof R & string : never) : never;
export type SettingId = { [P in SettingsPane]: `${P}.${RowKeysOf<P>}` }[SettingsPane];

export type SettingEntry = Searchable & { id: SettingId; pane: SettingsPane; section: string; explained?: boolean; needs?: string; shown?: (settings: Settings, env: SettingsEnv) => boolean };

export const paneTitle = (pane: SettingsPane) => PANE_LOOKS[pane].title;

export const SETTINGS: SettingEntry[] = SETTINGS_PANES.flatMap((pane) =>
  SECTIONS[pane].flatMap(({ section, rows }) =>
    Object.entries(rows).map(([key, row]) => ({
      ...row,
      id: `${pane}.${key}` as SettingId,
      pane,
      paneTitle: paneTitle(pane),
      section,
    })),
  ),
);

const byId = new Map(SETTINGS.map((s) => [s.id, s]));

export const findSetting = (id: string): SettingEntry | undefined => byId.get(id as SettingId);

export function setting(id: SettingId): SettingEntry {
  const entry = byId.get(id);
  if (!entry) throw new Error(`no setting ${id}`);
  return entry;
}

export const SETTINGS_INDEX = prepare(SETTINGS);

export const unshownSettings = (settings: Settings, env: SettingsEnv) =>
  SETTINGS.filter((e) => e.shown && !e.shown(settings, env))
    .map((e) => e.id)
    .join("\n");

export const sectionEntries = (pane: SettingsPane, section: string) => SETTINGS.filter((s) => s.pane === pane && s.section === section);
