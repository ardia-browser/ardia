import { PROFILE_COLORS } from "../ui";
import type { ProfileColor } from "../../state/browser/types";
import type { View } from "react-native";
import { showSpaceMenu, type SpaceMenuPlace } from "../../state/spaces/spaceMenu";
import { iconMenuItems } from "./SpaceIcons";

const COLORS = (Object.keys(PROFILE_COLORS) as ProfileColor[]).map((id) => ({ id, title: PROFILE_COLORS[id].name, swatch: PROFILE_COLORS[id].swatch }));

export function openSpaceItemMenu(profileId: string, place: SpaceMenuPlace, windowId?: string, _anchor?: View | null) {
  return showSpaceMenu(profileId, {
    place,
    windowId,
    iconItems: (current) => iconMenuItems(current, place === "sidebar" ? "None" : "Initial"),
    colors: COLORS,
  });
}
