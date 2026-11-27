import { useEffect, useRef } from "react";
import type { ViewInstance } from "react-native";
import { setMaterialYou } from "../../state/settings/actions";
import { focusForScreenReader } from "../ui/coverFocus";
import type { SettingsReveal } from "./settingsReveal";

export function useMaterialYouSwitch(material: boolean, landing: () => ViewInstance | null) {
  const reveal = useRef<SettingsReveal>(null);
  const restoresFocus = useRef(false);
  useEffect(() => {
    if (!restoresFocus.current) return;
    restoresFocus.current = false;
    reveal.current?.(landing());
    return focusForScreenReader(landing);
  }, [material]);
  const change = (value: boolean) => {
    restoresFocus.current = true;
    setMaterialYou(value);
  };
  return { reveal, change };
}
