import type { ReactNode } from "react";
import { View } from "react-native";
import { space } from "../../ui";
import { PaneIntro } from "../Form";

export function PaneSubPage({ intro, children }: { intro?: string; children: ReactNode }) {
  return (
    <View style={TOP}>
      {intro ? <PaneIntro>{intro}</PaneIntro> : null}
      {children}
    </View>
  );
}

const TOP = { marginTop: space.xl } as const;
