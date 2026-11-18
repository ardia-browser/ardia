import type { SettingSection } from "./types";

export const unloadedTabAppearance = {
      section: "Unloaded tab appearance",
      rows: {
        fadeUnloadedTabTitles: {
          advanced: true,
          title: "Fade titles",
          description: "Fade titles of sleeping tabs, closed pinned tabs, and tabs waiting to load after a restart.",
          keywords: ["asleep", "discarded", "dim", "grey", "gray", "inactive", "pinned", "closed"],
        },
        fadeUnloadedTabs: {
          advanced: true,
          title: "Fade icons",
          description: "A tab whose page isn't loaded, like a closed pinned tab or one restored after a relaunch, shows its icon faded, as sleeping tabs do. Clicking it loads the page.",
          keywords: ["unloaded", "asleep", "sleeping", "discarded", "dim", "grey", "gray", "inactive", "pinned", "closed"],
        },
        strikeSleepingTabs: {
          title: "Strike through sleeping tabs",
          description: "A tab Memory Saver or the ardia command put to sleep shows its title struck through and dimmed, in the sidebar and across the top, until its page loads again. A tab whose icon is faded as unloaded, with Fade icons of unloaded tabs on or a closed Top App without its tile, shows it too.",
          keywords: ["strikethrough", "strike", "line through", "crossed out", "asleep", "sleeping", "discarded", "unloaded", "memory saver", "dim", "title"],
        },
        grayscaleUnloadedFavicons: {
          advanced: true,
          title: "Grayscale favicons",
          description: "Remove color from favicons of sleeping and unloaded tabs. Independent of title and icon fading.",
          keywords: ["gray", "grey", "grayscale", "greyscale", "asleep", "sleeping", "unloaded", "icons", "color"],
        },
      },
    } satisfies SettingSection;
