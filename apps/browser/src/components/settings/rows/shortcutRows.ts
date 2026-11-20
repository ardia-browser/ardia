import { type SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";
import { keyText } from "../../../state/commands/keyText";
import { splitViewAvailable } from "../../../state/splits/splits";

export const shortcutRows = {
  shortcuts: [
    {
      section: "Keyboard",
      rows: {
        menuCommands: {
          title: "Keyboard shortcuts",
          keywords: ["shortcuts", "keyboard shortcuts", "hotkeys", "keybindings", "remap", "menu shortcuts", "customize keyboard shortcuts"],
        },
        extensionShortcuts: {
          title: "Extension commands",
          description: "Shortcuts that extensions add.",
          keywords: ["hotkeys", "extension shortcuts"],
        },
        undoReopensClosedTab: {
          title: `${keyText("⌘Z")} reopens closed tabs`,
          explained: true,
          description: `Outside text fields. In a text field, ${keyText("⌘Z")} still undoes typing.`,
          keywords: ["undo", "undo close tab", "reopen", "restore tab", "arc", "cmd z"],
        },
      },
    },
    {
      section: "Clicks",
      rows: {
        peekModifier: {
          title: "Peek gesture",
          description: "Opens the link in a preview over the page.",
          keywords: ["peek", "preview", "shift click", "option click", "arc"],
        },
        splitLinkModifier: {
          title: "Split view gesture",
          description: "Opens the link in a pane beside the page.",
          keywords: ["split view", "split screen", "side by side", "option click", "alt click", "option shift click", "dia"],
          offered: () => splitViewAvailable,
        },
        cmdClickCreatesTabGroup: {
          title: `${keyText("⌘")}-clicking links creates tab groups`,
          explained: true,
          keywords: ["command click", "cmd click"],
        },
        optShiftClickOpensInGroup: {
          title: `${keyText("⌥⇧")}-click opens tab in group`,
          explained: true,
          description: "Opens the tab in a group with the current tab.",
          keywords: ["option shift click", "split"],
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "shortcuts">;
