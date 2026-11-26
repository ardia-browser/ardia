import type { SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";

export const SETTING_ALIASES: Readonly<Record<string, string>> = { "plugins.official": "plugins.marketplace", "plugins.cli": "plugins.marketplace" };

export const pluginRows = {
  plugins: [
    {
      section: "Marketplace",
      rows: {
        marketplace: {
          title: "Get plugins",
          description: "Plugins from Ardia's registry and the ones you add. Each asks before it gets anything.",
          keywords: ["marketplace", "plugin registry", "get plugins", "install plugin", "official plugins", "command line", "ardia command", "beta"],
        },
        registries: {
          title: "Registries",
          description: "Other plugin registries, like your company's, and which scopes they serve.",
          keywords: ["registry", "custom registry", "company plugins", "scope"],
        },
      },
    },
    {
      section: "Plugins",
      rows: {
        plugins: {
          title: "Plugins",
          description: "Yours stay off until you turn them on.",
          keywords: ["plugin", "add-on", "addon", "install plugin", "ardia plugins", "install from folder", "tar.gz", "dev link"],
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "plugins">;
