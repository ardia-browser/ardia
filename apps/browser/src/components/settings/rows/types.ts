import type { Settings } from "../../../state/settings/settings";
import type { SettingsCapabilities } from "../../../state/settings/capabilities";

export type SettingsEnv = { top: boolean; glass?: boolean; syncOn?: boolean; syncAvailable?: boolean; fallbackOpensTab?: boolean; capabilities?: SettingsCapabilities; calendarAccess?: boolean; officialPlugins?: readonly string[] };
export type SettingRow = { title: string; description?: string; explained?: boolean; keywords?: string[]; offered?: (env: SettingsEnv) => boolean; capability?: keyof SettingsCapabilities; shown?: (settings: Settings, env: SettingsEnv) => boolean; needs?: string | ((settings: Settings) => string); unlock?: string | ((settings: Settings) => string) };
export type SettingSection = { section: string; rows: Record<string, SettingRow> };

export const APP = "Ardia";
