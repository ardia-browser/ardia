import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { View, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
import { useCoverFocus, type FocusTarget } from "./coverFocus";
import { useFocusReturn } from "./focusReturn";

export type OverlayTouch = "auto" | "box-none";

export function closingGate(closing: boolean, touch: OverlayTouch = "auto") {
  return {
    pointerEvents: closing ? ("none" as const) : touch,
    accessibilityElementsHidden: closing,
    importantForAccessibility: closing ? ("no-hide-descendants" as const) : ("auto" as const),
  };
}

type ModalOverlayOptions = {
  open: boolean;
  closing?: boolean;
  onDismiss: () => void;
  focus?: RefObject<ViewInstance | null>;
  returnFocusTo?: FocusTarget;
  touch?: OverlayTouch;
};

export function useModalOverlay({ open, closing = false, onDismiss, focus, returnFocusTo, touch = "auto" }: ModalOverlayOptions) {
  const live = open && !closing;
  const ownFocus = useRef<ViewInstance>(null);
  useCoverFocus(focus ?? ownFocus, live);
  const returnFocus = useFocusReturn();
  const wasLive = useRef(live);
  const target = useRef(returnFocusTo);
  const returnFocusNow = useRef(returnFocus);
  const pendingReturn = useRef<(() => void) | null>(null);
  target.current = returnFocusTo;
  returnFocusNow.current = returnFocus;
  useEffect(() => {
    const leaving = wasLive.current && !live;
    wasLive.current = live;
    if (live) {
      pendingReturn.current?.();
      pendingReturn.current = null;
      return;
    }
    if (leaving && target.current) pendingReturn.current = returnFocus(target.current);
  }, [live, returnFocus]);
  useEffect(
    () => () => {
      if (wasLive.current && target.current) pendingReturn.current = returnFocusNow.current(target.current);
    },
    [],
  );
  return {
    ref: focus ? undefined : ownFocus,
    accessibilityViewIsModal: live,
    onAccessibilityEscape: live ? onDismiss : undefined,
    ...closingGate(!live, touch),
  };
}

type ModalOverlayProps = ModalOverlayOptions & { style?: StyleProp<ViewStyle>; testID?: string; children: ReactNode };

export function ModalOverlay({ style, testID, children, ...options }: ModalOverlayProps) {
  const { ref, ...props } = useModalOverlay(options);
  return (
    <View ref={ref} testID={testID} collapsable={false} style={style} {...props}>
      {children}
    </View>
  );
}
