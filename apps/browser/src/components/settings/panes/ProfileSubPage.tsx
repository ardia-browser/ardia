import type { ReactNode } from "react";
import { View } from "react-native";
import { space } from "../../ui";
import { useSpace, useSettings } from "../../../state/browser/hooks";

export function useSelectedProfile(chosen: string | null): string {
  const exists = useSpace(chosen, (p) => !!p);
  const fallback = useSettings((s) => s.defaultSpaceId);
  return chosen && exists ? chosen : fallback;
}

export function ProfileSubPage({ children }: { children: ReactNode }) {
  return <View style={TOP}>{children}</View>;
}

const TOP = { marginTop: space.xl } as const;
