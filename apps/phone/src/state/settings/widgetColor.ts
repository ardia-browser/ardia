import { themeAccent } from "@ardia/core/src/theme.ts";
import { setWidgetColorChoice } from "../../platform/system";
import type { Preferences } from "./preferences";
import { usePreferences } from "./store";

let stop: (() => void) | null = null;

export function widgetColorOf({ colorChoice, customTheme }: Pick<Preferences, "colorChoice" | "customTheme">): string | null {
  if (colorChoice !== "custom") return colorChoice;
  return customTheme ? themeAccent(customTheme) : null;
}

export function followColorInWidgets() {
  stop?.();
  setWidgetColorChoice(widgetColorOf(usePreferences.getState()));
  stop = usePreferences.subscribe((now, before) => {
    if (now.colorChoice === before.colorChoice && now.customTheme === before.customTheme) return;
    const color = widgetColorOf(now);
    if (color !== widgetColorOf(before)) setWidgetColorChoice(color);
  });
  return () => {
    stop?.();
    stop = null;
  };
}
