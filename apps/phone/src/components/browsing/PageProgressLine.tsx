import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { LoadingLine } from "../ui";
import { pageLoadWatch } from "./barLoadWash";

export function PageProgressLine({ tabId, top }: { tabId: string; top: number }) {
  const watch = useMemo(() => pageLoadWatch(tabId), [tabId]);
  return (
    <View testID="pageProgressLine" style={[styles.place, { top }]} pointerEvents="none">
      <LoadingLine watch={watch} />
    </View>
  );
}

const styles = StyleSheet.create({
  place: { position: "absolute", left: 0, right: 0 },
});
