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
          description: "Made by Ardia and built into the app. Nothing is installed until you say so.",
          keywords: ["official", "plugins", "built in", "first party", "ardia plugins", "install"],
          shown: () => PLATFORM_FEATURES.plugins,
        },
        commandLine: {
          title: "Command Line",
          description: "The ardia command for your terminal, your shell and your agents (the CLI). One click installs it.",
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
          description: "Plugins add commands, panels, settings, helper programs and commands on your PATH. One you add stays off until you turn it on and see what it gets; the ones built into Ardia say so.",
          keywords: ["plugin", "add-on", "addon", "install plugin", "ardia plugins"],
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "plugins">;
