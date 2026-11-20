import { deleteProfileData } from "../../platform/profiles";
import { useBrowser } from "../browser/store";
import { engineProfile } from "../browser/model";
import { noteProfileDataDeleted } from "../telemetry/profileDataCounts";
import { consentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";

export { clearBrowsingData, type BrowsingDataType } from "../../platform/profiles";

const CLOSE_DELAY_MS = 1500;

const failed = new Set<string>();
let running = false;

const inUse = (engine: string) => {
  const s = useBrowser.getState();
  return Object.keys(s.profiles).some((id) => engineProfile(s, id) === engine);
};

async function drain() {
  if (running) return;
  running = true;
  const consent = consentToken();
  try {
    for (;;) {
      const engine = useBrowser.getState().orphanedProfileData.find((e) => !failed.has(e));
      if (engine === undefined) return;
      await new Promise((resolve) => setTimeout(resolve, CLOSE_DELAY_MS));
      if (inUse(engine)) {
        useBrowser.getState().profileDataDeleted(engine);
        continue;
      }
      const remaining = await deleteProfileData(engine).catch((error: unknown) => [String(error)]);
      noteProfileDataDeleted(!remaining.length, consent);
      if (remaining.length) {
        failed.add(engine);
        warnFor(consent, `Couldn't delete profile data (${engine || "original profile"}): ${remaining.join(", ")}`);
      } else {
        useBrowser.getState().profileDataDeleted(engine);
      }
    }
  } finally {
    running = false;
  }
}

export function startProfileDataCleanup() {
  failed.clear();
  void drain();
  return useBrowser.subscribeTo(["orphanedProfileData"], (s, prev) => {
    if (s.orphanedProfileData !== prev.orphanedProfileData) void drain();
  });
}
