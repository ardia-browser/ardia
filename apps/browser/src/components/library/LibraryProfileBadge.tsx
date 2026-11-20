import { memo } from "react";
import { View } from "react-native";
import { useProfile } from "../../state/browser/hooks";
import { ownerNamesOf } from "../../state/library/profileScope";
import { useProfileRecords } from "../../state/profiles/hooks";
import { capsule, useTheme } from "../ui";
import { ProfileBadge } from "../profiles/ProfileIcons";
import { profileColors } from "../profiles/tokens";
import { LIBRARY } from "./tokens";

const B = LIBRARY.profileBadge;
const ROW_CORNER = { position: "absolute", right: -B.rowOverhang, bottom: -B.rowOverhang } as const;
const CARD_CORNER = { position: "absolute", left: B.cardInset, top: B.cardInset } as const;

export const LibraryProfileBadge = memo(function LibraryProfileBadge({ owners, place }: { owners: readonly string[] | undefined; place: "row" | "card" }) {
  const theme = useTheme();
  const profile = useProfile(owners?.length === 1 ? owners[0] : null, (p) => p);
  if (!profile) return null;
  const ring = B.ring;
  const size = place === "row" ? B.row : B.card;
  return (
    <View
      pointerEvents="none"
      style={{
        ...(place === "row" ? ROW_CORNER : CARD_CORNER),
        width: size + 2 * ring,
        height: size + 2 * ring,
        borderRadius: capsule(size + 2 * ring),
        padding: ring,
        backgroundColor: profileColors.stackRing[theme.dark ? "dark" : "light"],
      }}
    >
      <ProfileBadge profile={profile} size={size} />
    </View>
  );
});


export function useOwnedLabel(label: string, owners: readonly string[] | undefined, shown: boolean): string {
  const names = useProfileRecords((profiles) => (shown ? ownerNamesOf(owners, profiles) : ""));
  return names ? `${label}, ${names}` : label;
}
