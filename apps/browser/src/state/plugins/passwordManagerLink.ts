import { settingsProfileFor } from "../extensions/store";
import { flashSetting } from "../settings/searchState";
import { goToSettingsPane, SETTINGS_DETAIL, useSettingsNav } from "../settings/settingsWindows";

export const passwordManagerAnchor = (name: string) => `passwords.manager.${name}`;

export function showPasswordManagerSettings(name: string) {
  goToSettingsPane("profiles", settingsProfileFor("profiles", useSettingsNav.getState()), SETTINGS_DETAIL.passwords);
  flashSetting(passwordManagerAnchor(name));
}
