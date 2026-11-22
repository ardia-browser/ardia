import type { Settings } from "../../../state/settings/settings";
import { t } from "../../../lib/uiLanguage";


export type SettingsEnv = { top: boolean; glass?: boolean; syncOn?: boolean; calendarAccess?: boolean; officialPlugins?: readonly string[] };
export type SettingRow = { title: string; description?: string; explained?: boolean; keywords?: string[]; shown?: (settings: Settings, env: SettingsEnv) => boolean; needs?: string };
export type SettingSection = { section: string; rows: Record<string, SettingRow> };

export const APP = t(`Ardia`);

export const WEBKIT_LIMITS_KEYWORDS = [t(`webkit limitations`), "limitations", t(`not supported`), "unsupported", "passkeys", t(`security keys`), t(`picture in picture`), t(`client hints`), "midi", "casting", "chromecast", "chrome.debugger", "webrequest", "removeparam", t(`about engines`), t(`how automatic works`)];

export const ENGINE_MODE_ROW = {
  title: t(`Engine`),
  keywords: [t(`engine mode`), "only", "just", t(`chromium only`), t(`webkit only`), "safari", "automatic", "always"],
} satisfies SettingRow;
