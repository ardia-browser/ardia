import type { SettingsEnv, SettingSection } from "./types";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { keyText } from "../../../state/commands/keyText";

const syncOn = (_: unknown, env: SettingsEnv) => !!env.syncOn;

export const workspaceRows = {
  spaces: [
    { section: "Default space", rows: { defaultSpace: { title: "Default space", description: "Links from other apps and new windows open in this space.", keywords: ["new window"] } } },
    {
      section: "Space switcher",
      rows: {
        switcherShows: {
          title: "Switcher in the sidebar shows",
          description: "Show dots, icons or nothing in the space switcher.",
          keywords: ["spaces", "space icons", "space dots", "switcher", "emoji", "symbol", "sidebar footer", "hide", "arc"],
        },
        spacesFollowAppearance: {
          title: "Space colors follow the app theme",
          description: "Use the app appearance for every space.",
          keywords: ["space theme", "profile theme", "follow system"],
        },
      },
    },
    { section: "Spaces", rows: { list: { title: "Spaces", description: `Drag to reorder. ${keyText("⌃1")}–${keyText("⌃9")} switch to the first nine.`, keywords: ["create space", "new space", "delete space", "reorder", "work", "personal"] } } },
  ],
  sync: [
    {
      section: "Sync",
      rows: {
        sync: { title: "Sync", description: "Keep profiles, spaces, tabs and settings in sync across your devices.", keywords: [PLATFORM_TERMS.cloudDrive.toLowerCase(), "recovery phrase", "turn on sync", "end to end", "encrypted"] },
        folder: { title: "Sync folder", keywords: ["icloud drive", "dropbox", "folder"], shown: syncOn, needs: "Turn on Sync to use this" },
        whatSyncs: { title: "What syncs", keywords: ["sync all open tabs", "unpinned tabs", "regular tabs", "today tabs", "open tabs", "data types"], shown: syncOn, needs: "Turn on Sync to use this" },
        devices: { title: "Devices", description: "Devices syncing with this one.", keywords: ["computers", "remove device"], shown: syncOn, needs: "Turn on Sync to use this" },
        profiles: { title: "Profiles", keywords: ["sync profile", "share top apps", "pinned tabs", "favorites", "essentials"], shown: syncOn, needs: "Turn on Sync to use this" },
      },
    },
  ],
} satisfies Record<"spaces" | "sync", SettingSection[]>;
