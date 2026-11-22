import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { launchArguments } from "../../state/app/launchFlags";
import { watchPageLoad } from "../../state/browse/hooks";
import { LoadingLine, type LoadWatch } from "../ui";

export function PageProgressLine({ tabId, top }: { tabId: string; top: number }) {
  const watch = useMemo<LoadWatch>(() => {
    const loadFreeze = launchArguments().loadFreeze;
    if (loadFreeze !== null) return (show) => (show(loadFreeze, true), () => undefined);
    return (show) => watchPageLoad(tabId, show);
  }, [tabId]);
  return (
    <View testID="pageProgressLine" style={[styles.place, { top }]} pointerEvents="none">
      <LoadingLine watch={watch} />
    </View>
  );
}

const styles = StyleSheet.create({
  place: { position: "absolute", left: 0, right: 0 },
});
