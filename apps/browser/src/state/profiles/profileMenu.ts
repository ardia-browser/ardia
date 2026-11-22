import type { View } from "react-native";
import { prompt } from "../../platform/dialogs";
import { chooseFromMenu, type ChoiceItem } from "../app/menuChoice";
import { menuSections } from "../app/menuSections";
import { deleteProfile } from "../browser/actions";
import { currentProfile, currentProfileOrder, currentProfiles, currentSettings } from "../browser/current";
import type { ProfileColor } from "../browser/types";
import { goToSettingsPane, openSettings } from "../settings/settingsWindows";
import { commitProfileName, setDefaultProfile, setShareTopApps } from "./actions";
import { sharingProfiles } from "./profiles";
import { openProfileIconPicker } from "./iconPicker";
import { choosePresetColor } from "./themeActions";
import { t } from "../../lib/uiLanguage";


export type ProfileMenuPlace = "sidebar" | "settings";
export type ProfileColorChoice = { id: ProfileColor; title: string; swatch: string };
type ProfileMenuItem = ChoiceItem<{ color: ProfileColor }, "rename" | "icon" | "color" | "topApps" | "settings" | "details" | "default" | "delete">;

export type ProfileMenuState = {
  place: ProfileMenuPlace;
  hasIcon: boolean;
  colors: ProfileColorChoice[];
  color: ProfileColor | null;
  isDefault: boolean;
  only: boolean;
  sharesTopApps: boolean | null;
};

export function profileMenuItems({ place, hasIcon, colors, color, isDefault, only, sharesTopApps }: ProfileMenuState): ProfileMenuItem[] {
  return menuSections<ProfileMenuItem>(
    [
      { id: "rename" as const, title: t(`Rename…`), symbol: "pencil" },
      { id: "icon" as const, title: hasIcon ? t(`Change Icon…`) : t(`Add Icon…`), symbol: "photo" },
      { id: "color" as const, title: t(`Color`), symbol: "paintpalette", children: colors.map((c) => ({ value: { color: c.id }, title: c.title, swatch: c.swatch, checked: c.id === color })) },
    ],
    [sharesTopApps !== null && { id: "topApps" as const, title: t(`Share Top Apps`), symbol: "square.grid.2x2", checked: sharesTopApps }],
    place === "sidebar"
      ? [{ id: "settings" as const, title: t(`Profile Settings…`), symbol: "gearshape" }]
      : [
          { id: "details" as const, title: t(`Show Profile Details`), symbol: "info.circle" },
          { id: "default" as const, title: t(`Make Default Profile`), symbol: "star", enabled: !isDefault },
        ],
    [{ id: "delete" as const, title: t(`Delete Profile…`), symbol: "trash", enabled: !only }],
  );
}

export async function renameProfile(profileId: string, windowId?: string) {
  const profile = currentProfile(profileId);
  if (!profile) return;
  const name = await prompt({ title: t(`Rename Profile`), value: profile.name, placeholder: t(`Profile name`), confirmTitle: t(`Rename`), windowId });
  if (name !== null) commitProfileName(profileId, name);
}

export async function showProfileMenu(
  profileId: string,
  { place, windowId, anchor, colors }: { place: ProfileMenuPlace; windowId: string; anchor: View | null; colors: ProfileColorChoice[] },
) {
  const profile = currentProfile(profileId);
  if (!profile) return;
  const choice = await chooseFromMenu(
    profileMenuItems({
      place,
      hasIcon: !!profile.icon,
      colors,
      color: profile.color,
      isDefault: currentSettings().defaultProfileId === profileId,
      only: currentProfileOrder().length <= 1,
      sharesTopApps: sharingProfiles({ profiles: currentProfiles(), profileOrder: currentProfileOrder() }, profileId).length ? !!profile.shareTopApps : null,
    }),
  );
  if (!choice) return;
  if (typeof choice === "object") return choosePresetColor(profileId, choice.color);
  if (choice === "icon") return void openProfileIconPicker(profileId, windowId, place, anchor);
  if (choice === "rename") return void renameProfile(profileId, windowId);
  if (choice === "topApps") return setShareTopApps(profileId, !currentProfile(profileId)?.shareTopApps);
  if (choice === "settings") return openSettings("profiles", profileId);
  if (choice === "details") return goToSettingsPane("profiles", profileId);
  if (choice === "default") return setDefaultProfile(profileId);
  if (choice === "delete") return void deleteProfile(profileId, windowId);
}
