import type { SettingsPane } from "../../../state/settings/settingsWindows";
import { keyText } from "../../../state/commands/keyText";
import type { SettingSection } from "./types";

export const profileRows = {
  profiles: [
    { section: "New windows open with", rows: { defaultProfile: { title: "Default profile", description: "Used for new windows. Links from other apps open in the profile you used last.", keywords: ["new window"] } } },
    {
      section: "Shared data",
      rows: {
        shareTopApps: {
          title: "Share Top Apps",
          description:
            "Profiles that share browsing data can show the same Top Apps, each one a single page you pick up where you left it in any of them. Pick which ones take part. A profile with its own data keeps its own Top Apps, since its logins and cookies are separate.",
          keywords: ["pinned tabs", "favorites", "essentials", "spaces", "shared"],
        },
      },
    },
    {
      section: "Profile switcher",
      rows: {
        showProfileDots: {
          title: "Show profile dots",
          description: `The dots at the bottom of the sidebar that switch profiles. Swiping and ${keyText("⌃1")}–${keyText("⌃9")} still work.`,
          keywords: ["dots", "pager", "profile switcher", "page dots", "sidebar footer", "hide"],
        },
        switcherIcons: {
          title: "Show profile icons instead of dots",
          description: "As in Arc: the switcher at the bottom of the sidebar shows each profile's symbol or emoji, and a profile without one keeps its dot. Right-click the switcher to pick an icon.",
          keywords: ["spaces", "space icons", "profile dots", "switcher", "emoji", "symbol", "sidebar footer", "arc"],
        },
      },
    },
    { section: "Profiles", rows: { list: { title: "Profiles", description: `Drag to reorder. ${keyText("⌃1")}–${keyText("⌃9")} switch to the first nine.`, keywords: ["create profile", "new profile", "delete profile", "reorder", "work", "personal"] } } },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "profiles">;
