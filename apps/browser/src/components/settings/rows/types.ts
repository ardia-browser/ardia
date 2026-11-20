import type { Settings } from "../../../state/settings/settings";

export type SettingsEnv = { top: boolean; glass?: boolean; syncOn?: boolean; calendarAccess?: boolean; officialPlugins?: readonly string[] };
export type SettingRow = { title: string; description?: string; explained?: boolean; keywords?: string[]; shown?: (settings: Settings, env: SettingsEnv) => boolean; needs?: string };
export type SettingSection = { section: string; rows: Record<string, SettingRow> };

export const APP = "Ardia";
