import type { SettingRow, SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";
import { OFFICIAL_ANCHOR_ALIASES, OFFICIAL_CATALOGUE, COMING_SOON } from "../../../state/plugins/officialPin";
import { t } from "../../../lib/uiLanguage";


export const officialPluginAnchor = (name: string) => `plugins.${name}` as const;

const officialRows: Record<string, SettingRow> = Object.fromEntries(
  [...OFFICIAL_CATALOGUE, ...COMING_SOON].map((p) => [
    p.name,
    {
      title: p.title,
      description: p.blurb,
      keywords: [t(`official plugin`), t(`built in plugin`)],
      shown: (_, env) => !!env.officialPlugins?.includes(p.name),
    } satisfies SettingRow,
  ]),
);

export const SETTING_ALIASES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(OFFICIAL_ANCHOR_ALIASES).flatMap(([name, aliases]) => aliases.map((alias) => [`plugins.${alias}`, officialPluginAnchor(name)])),
);

export const pluginRows = {
  plugins: [
    {
      section: t(`Official`),
      rows: {
        official: {
          title: t(`Official plugins`),
          keywords: ["official", "plugins", t(`built in`), t(`first party`), t(`ardia plugins`), "install"],
          shown: (_, env) => !!env.officialPlugins?.length,
        },
        ...officialRows,
      },
    },
    {
      section: t(`Plugins`),
      rows: {
        plugins: {
          title: t(`Plugins`),
          description: t(`Yours stay off until you turn them on.`),
          keywords: ["plugin", "add-on", "addon", t(`install plugin`), t(`ardia plugins`)],
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "plugins">;
