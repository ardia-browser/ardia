import { useBrowser } from "../browser/store";
import type { Settings } from "../settings/settings";
import { useSystemIncreaseContrast, watchSystemContrast } from "../app/systemContrast";

export const highContrastSidebarText = (contrast: Settings["sidebarTextContrast"], increaseContrast: boolean) => contrast === "high" || (contrast === "auto" && increaseContrast);

export function useSidebarHighContrast(): boolean {
  watchSystemContrast();
  const contrast = useBrowser((s) => s.settings.sidebarTextContrast);
  const increaseContrast = useSystemIncreaseContrast((s) => s.on);
  return highContrastSidebarText(contrast, increaseContrast);
}
