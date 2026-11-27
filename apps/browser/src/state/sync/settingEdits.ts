import { hlcWall, type Adapter } from "../../platform/sync";
import { useBrowser } from "../browser/store";
import { settingOf } from "./settingsAdapter";

export function withSettingEdits(adapter: Adapter): Adapter {
  return {
    ...adapter,
    extract: async (base, queued, now, known, remote, stamp, baseJson) => {
      const extraction = await adapter.extract(base, queued, now, known, remote, stamp, baseJson);
      if (!extraction) return extraction;
      const chosenAt = useBrowser.getState().settingsMeta.chosenAt ?? {};
      return {
        ...extraction,
        keepLocal: (key) => {
          const at = chosenAt[settingOf(key)];
          const synced = stamp(key);
          return at !== undefined && (synced === undefined || at > hlcWall(synced));
        },
      };
    },
  };
}
