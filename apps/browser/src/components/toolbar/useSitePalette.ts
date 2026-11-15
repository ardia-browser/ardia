import { useAppDark, useSettings, useTab, useTabLive } from "../../state/browser/hooks";
import { useTheme } from "../ui/theme";
import { toolbarPalette, type ToolbarPalette } from "../ui/toolbarColors";
import { useReaderState } from "../../state/reader/reader";
import { READER_GROUND } from "../../state/reader/tokens";

export function useSitePalette(tabId: string): ToolbarPalette {
  const theme = useTheme();
  const hasUrl = useTab(tabId, (t) => !!t?.url);
  const themeColor = useTabLive(tabId, (l) => l.themeColor);
  const extendColor = useSettings((s) => s.extendWebsiteColor);
  const reading = useReaderState(tabId).active;
  const appDark = useAppDark();
  const pageColor = reading ? READER_GROUND[appDark ? "dark" : "light"] : themeColor;
  return toolbarPalette(theme, extendColor && hasUrl ? pageColor : null);
}
