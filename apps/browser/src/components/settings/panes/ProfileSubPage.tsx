import type { ReactNode } from "react";
import { View } from "react-native";
import { space } from "../../ui";
import { useProfile, useSettings } from "../../../state/browser/hooks";

export function useSelectedProfile(chosen: string | null): string {
  const exists = useProfile(chosen, (p) => !!p);
  const fallback = useSettings((s) => s.defaultProfileId);
  return chosen && exists ? chosen : fallback;
}

export function ProfileSubPage({ children }: { children: ReactNode }) {
  return <View style={TOP}>{children}</View>;
}

const TOP = { marginTop: space.xl } as const;
