import { onSettingsChosen } from "../../browser/src/state/settings/settingsPatch";
import { deliverToAuthority } from "./profileRetirement";

type Timers = Parameters<typeof deliverToAuthority>[3];

export function forwardSettingChoices(leading: () => boolean, send: (names: string[]) => Promise<unknown>, recordHere: (names: string[]) => void, timers?: Timers): () => void {
  const deliver = deliverToAuthority(leading, send, recordHere, timers);
  return onSettingsChosen((names) => {
    if (!leading()) deliver(names);
  });
}
