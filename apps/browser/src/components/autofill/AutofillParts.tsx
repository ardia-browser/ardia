import { View } from "react-native";
import type { SavedAddress } from "../../state/site/autofill";
import { Symbol, useTheme } from "../ui";
import { AUTOFILL } from "./tokens";

export const addressSymbol = (
  a: Pick<SavedAddress, "name" | "organization"> | undefined,
) =>
  a?.name?.trim()
    ? "person.crop.circle"
    : a?.organization?.trim()
      ? "building.2"
      : "mappin.and.ellipse";

export function AddressGlyph({
  address,
  size = AUTOFILL.rowGlyph,
}: {
  address?: Pick<SavedAddress, "name" | "organization">;
  size?: number;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: AUTOFILL.rowIcon,
        height: AUTOFILL.rowIcon,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Symbol
        name={addressSymbol(address)}
        size={size}
        color={theme.icon}
        style={{ width: AUTOFILL.rowIcon, height: AUTOFILL.rowIcon }}
      />
    </View>
  );
}
