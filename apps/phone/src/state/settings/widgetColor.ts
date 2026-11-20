import { setWidgetColorChoice } from "../../platform/system";
import { usePreferences } from "./store";

let stop: (() => void) | null = null;

export function followColorInWidgets() {
  stop?.();
  setWidgetColorChoice(usePreferences.getState().colorChoice);
  stop = usePreferences.subscribe((now, before) => {
    if (now.colorChoice !== before.colorChoice) setWidgetColorChoice(now.colorChoice);
  });
  return () => {
    stop?.();
    stop = null;
  };
}
