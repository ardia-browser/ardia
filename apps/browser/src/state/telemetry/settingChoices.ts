import type { Settings } from "../settings/settings";
import { noteAutoHideTabsChosen } from "./autoHideTabsChoices";
import { noteMinimalismPinnedIcons, noteMinimalismToggled } from "./minimalismCounts";

type Watched = Pick<Settings, "autoHideTabs" | "minimalismMode" | "minimalismPinnedIcons">;

export function noteSettingChoices(before: Watched, patch: Partial<Watched>, inferring: boolean) {
  if (patch.autoHideTabs !== undefined && patch.autoHideTabs !== before.autoHideTabs) noteAutoHideTabsChosen();
  if (patch.minimalismMode !== undefined && patch.minimalismMode !== before.minimalismMode) noteMinimalismToggled(patch.minimalismMode);
  if (!inferring && patch.minimalismPinnedIcons !== undefined && patch.minimalismPinnedIcons !== before.minimalismPinnedIcons) noteMinimalismPinnedIcons(patch.minimalismPinnedIcons);
}
