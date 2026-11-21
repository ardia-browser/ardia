import type { Settings } from "../settings/settings";

export const profileSwitcherShown = (settings: Pick<Settings, "showProfileDots">, profileCount: number, incognito: boolean) =>
  settings.showProfileDots && !incognito && profileCount > 1;
