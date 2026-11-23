import { useRef } from "react";
import { StyleSheet, View } from "react-native";
import { useInputRegion } from "./shellAbove";
import { Sidebar as BrowserSidebar } from "../../browser/src/components/sidebar/Sidebar";
import { SIDEBAR_RESIZE_HANDLE } from "../../browser/src/components/sidebar/tokens";
import { useSidebarSide, useWindowId } from "../../browser/src/state/browser/hooks";
import { usePeekSpan } from "../../browser/src/state/windows/dockMotion";

export function Sidebar(props: React.ComponentProps<typeof BrowserSidebar>) {
  const windowId = useWindowId();
  const peeking = usePeekSpan(windowId) !== undefined;
  const right = useSidebarSide(windowId) === "right";
  return (
    <>
      <BrowserSidebar {...props} />
      {peeking && <PeekMark right={right} />}
    </>
  );
}

function PeekMark({ right }: { right: boolean }) {
  const mark = useRef<View & Element>(null);
  useInputRegion(mark);
  return <View ref={mark} testID="ardia-sidebar-peek" pointerEvents="none" style={[StyleSheet.absoluteFill, { [right ? "left" : "right"]: -SIDEBAR_RESIZE_HANDLE.width / 2 }]} />;
}
