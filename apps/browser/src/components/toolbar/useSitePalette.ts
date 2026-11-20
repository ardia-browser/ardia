import { useRef } from "react";
import { useAppDark, useSettings, useTab, useTabLive } from "../../state/browser/hooks";
import { useTheme } from "../ui/theme";
import { toolbarPalette, type ToolbarPalette } from "../ui/toolbarColors";
import { useReaderState } from "../../state/reader/reader";
import { READER_GROUND } from "../../state/reader/tokens";
import { previewedToolbarTab, usePeekToolbarPreview } from "../../state/peek/toolbarPreview";

export function useSitePalette(shownTabId: string): ToolbarPalette {
  const theme = useTheme();
  const tabId = usePeekToolbarPreview((p) => previewedToolbarTab(p, shownTabId));
  const hasUrl = useTab(tabId, (t) => !!t?.url);
  const themeColor = useTabLive(tabId, (l) => l.themeColor);
  const extendColor = useSettings((s) => s.extendWebsiteColor);
  const reading = useReaderState(tabId).active;
  const appDark = useAppDark();
  const pageColor = reading ? READER_GROUND[appDark ? "dark" : "light"] : themeColor;
  const palette = toolbarPalette(theme, extendColor && hasUrl ? pageColor : null);
  const kept = useRef(palette);
  if (kept.current !== palette && !samePalette(kept.current, palette)) kept.current = palette;
  return kept.current;
}

const samePalette = (a: ToolbarPalette, b: ToolbarPalette) => (Object.keys(a) as (keyof ToolbarPalette)[]).every((key) => a[key] === b[key]) && Object.keys(a).length === Object.keys(b).length;
