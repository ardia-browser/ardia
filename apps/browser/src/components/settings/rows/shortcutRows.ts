import { type SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";
import { keyText } from "../../../state/commands/keyText";
import { splitViewAvailable } from "../../../state/splits/splits";
import { t } from "../../../lib/uiLanguage";


export const shortcutRows = {
  shortcuts: [
    {
      section: t(`Keyboard`),
      rows: {
        menuCommands: {
          title: t(`Keyboard shortcuts`),
          keywords: ["shortcuts", t(`keyboard shortcuts`), "hotkeys", "keybindings", "remap", t(`menu shortcuts`), t(`customize keyboard shortcuts`), t(`mouse button`), t(`middle click`), t(`mouse shortcut`), t(`side button`)],
        },
        extensionShortcuts: {
          title: t(`Extension commands`),
          description: t(`Shortcuts that extensions add.`),
          keywords: ["hotkeys", t(`extension shortcuts`)],
        },
        undoReopensClosedTab: {
          title: `${keyText("⌘Z")} reopens closed tabs`,
          explained: true,
          description: `Outside text fields. In a text field, ${keyText("⌘Z")} still undoes typing.`,
          keywords: ["undo", t(`undo close tab`), "reopen", t(`restore tab`), "arc", t(`cmd z`)],
        },
      },
    },
    {
      section: t(`Clicks`),
      rows: {
        peekModifier: {
          title: t(`Peek a link with`),
          description: t(`Opens the link in a preview over the page.`),
          keywords: ["peek", "preview", t(`shift click`), t(`option click`), "arc"],
        },
        splitLinkModifier: {
          title: t(`Open a link in split view with`),
          description: t(`Opens the link in a pane beside the page.`),
          keywords: [t(`split view`), t(`split screen`), t(`side by side`), t(`option click`), t(`alt click`), t(`option shift click`), "download", "dia"],
          shown: () => splitViewAvailable,
        },
        cmdClickCreatesTabGroup: {
          title: `${keyText("⌘")}-clicking links creates tab groups`,
          explained: true,
          keywords: [t(`command click`), t(`cmd click`)],
        },
        optShiftClickOpensInGroup: {
          title: `${keyText("⌥⇧")}-click opens tab in group`,
          explained: true,
          description: t(`Opens the tab in a group with the current tab.`),
          keywords: [t(`option shift click`), "split"],
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "shortcuts">;
