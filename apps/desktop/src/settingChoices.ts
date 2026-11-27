import { onSettingsChosen } from "../../browser/src/state/settings/settingsPatch";

export function forwardSettingChoices(leading: () => boolean, send: (names: string[]) => Promise<unknown>): () => void {
  return onSettingsChosen((names) => {
    if (!leading()) void send(names).catch(() => undefined);
  });
}
