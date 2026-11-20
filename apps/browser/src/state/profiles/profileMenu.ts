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

export type ProfileMenuPlace = "sidebar" | "settings" | "library";
export type ProfileColorChoice = { id: ProfileColor; title: string; swatch: string };
export type ProfileMenuChoice = "rename" | "icon" | "color" | "topApps" | "moveLeft" | "moveRight" | "newProfile" | "settings" | "details" | "default" | "delete";
type ProfileMenuItem = ChoiceItem<{ color: ProfileColor }, ProfileMenuChoice>;
type ProfileColorItem = ChoiceItem<{ color: ProfileColor }, never>;

export type ProfileMenuState = {
  place: ProfileMenuPlace;
  hasIcon: boolean;
  colors: ProfileColorChoice[];
  color: ProfileColor | null;
  isDefault: boolean;
  only: boolean;
  sharesTopApps: boolean | null;
  moves?: { left: boolean; right: boolean };
};

export const profileColorItems = (colors: ProfileColorChoice[], color: ProfileColor | null): ProfileColorItem[] =>
  colors.map((c) => ({ value: { color: c.id }, title: c.title, swatch: c.swatch, checked: c.id === color }));

export function profileMenuItems({ place, hasIcon, colors, color, isDefault, only, sharesTopApps, moves }: ProfileMenuState): ProfileMenuItem[] {
  return menuSections<ProfileMenuItem>(
    [
      { id: "rename" as const, title: "Rename…", symbol: "pencil" },
      { id: "icon" as const, title: hasIcon ? "Change Icon…" : "Add Icon…", symbol: "photo" },
      { id: "color" as const, title: "Color", symbol: "paintpalette", children: profileColorItems(colors, color) },
    ],
    [sharesTopApps !== null && { id: "topApps" as const, title: "Share Top Apps", symbol: "square.grid.2x2", checked: sharesTopApps }],
    place === "library" && moves
      ? [
          { id: "moveLeft" as const, title: "Move Left", symbol: "chevron.left", enabled: moves.left },
          { id: "moveRight" as const, title: "Move Right", symbol: "chevron.right", enabled: moves.right },
        ]
      : [],
    place === "settings"
      ? [
          { id: "details" as const, title: "Show Profile Details", symbol: "info.circle" },
          { id: "default" as const, title: "Make Default Profile", symbol: "star", enabled: !isDefault },
        ]
      : [
          place === "library" && { id: "newProfile" as const, title: "New Profile…", symbol: "plus" },
          { id: "settings" as const, title: "Profile Settings…", symbol: "gearshape" },
        ],
    [{ id: "delete" as const, title: "Delete Profile…", symbol: "trash", enabled: !only }],
  );
}

export function profileMenuStateOf(profileId: string, place: ProfileMenuPlace, colors: ProfileColorChoice[]): ProfileMenuState | null {
  const profile = currentProfile(profileId);
  if (!profile) return null;
  const order = currentProfileOrder();
  const at = order.indexOf(profileId);
  return {
    place,
    hasIcon: !!profile.icon,
    colors,
    color: profile.theme ? null : profile.color,
    isDefault: currentSettings().defaultProfileId === profileId,
    only: order.length <= 1,
    sharesTopApps: sharingProfiles({ profiles: currentProfiles(), profileOrder: order }, profileId).length ? !!profile.shareTopApps : null,
    moves: place === "library" ? { left: at > 0, right: at >= 0 && at < order.length - 1 } : undefined,
  };
}

export async function renameProfile(profileId: string, windowId?: string) {
  const profile = currentProfile(profileId);
  if (!profile) return;
  const name = await prompt({ title: "Rename Profile", value: profile.name, placeholder: "Profile name", confirmTitle: "Rename", windowId });
  if (name !== null) commitProfileName(profileId, name);
}

export async function showProfileMenu(
  profileId: string,
  { place, windowId, anchor, colors }: { place: ProfileMenuPlace; windowId: string; anchor: View | null; colors: ProfileColorChoice[] },
) {
  const state = profileMenuStateOf(profileId, place, colors);
  if (!state) return;
  const choice = await chooseFromMenu(profileMenuItems(state));
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
