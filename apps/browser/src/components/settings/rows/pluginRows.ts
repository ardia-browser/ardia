import type { SettingSection } from "./types";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import type { SettingsPane } from "../../../state/settings/settingsWindows";

export const pluginRows = {
  plugins: [
    {
      section: "Official",
      rows: {
        official: {
          title: "Official plugins",
          keywords: ["official", "plugins", "built in", "first party", "ardia plugins", "install"],
          shown: () => PLATFORM_FEATURES.plugins,
        },
        commandLine: {
          title: "Command Line",
          description: "The ardia command (CLI) for your terminal or shell.",
          keywords: ["install the ardia command", "official plugin", "built in plugin", "path"],
          shown: () => PLATFORM_FEATURES.plugins,
        },
      },
    },
    {
      section: "Plugins",
      rows: {
        plugins: {
          title: "Plugins",
          description: "Yours stay off until you turn them on.",
          keywords: ["plugin", "add-on", "addon", "install plugin", "ardia plugins"],
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "plugins">;
