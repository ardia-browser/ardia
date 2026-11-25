import { useEffect, type RefObject } from "react";
import { findNodeHandle, type TextInput } from "react-native";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { claimFocusTag, onFocusExpected } from "../../state/focus/focusClaims";

export type FocusClaim = { windowId: string; destination: string };

export function useClaimFollowsFocus(input: RefObject<TextInput | null>, claim: FocusClaim | undefined) {
  const windowId = claim?.windowId;
  const destination = claim?.destination;
  const tagOf = () => findNodeHandle(input.current);
  useEffect(() => {
    if (!PLATFORM_FEATURES.claimsFollowFocus || !windowId || !destination) return;
    return onFocusExpected((expectedIn, expected) => {
      if (expectedIn === windowId && expected === destination && input.current?.isFocused()) claimFocusTag(windowId, destination, tagOf);
    });
  }, [windowId, destination]);
  return () => {
    if (PLATFORM_FEATURES.claimsFollowFocus && windowId && destination) claimFocusTag(windowId, destination, tagOf);
  };
}
