import type { SyncNative } from "../../platform/sync";
import type { ConsentToken } from "../telemetry/choice";
import { warnFor } from "../telemetry/logs";
import { emptyDoc, type SyncDoc, type SyncUi } from "./syncDoc";

export type StopSteps = {
  native: () => typeof SyncNative;
  doc: () => SyncDoc;
  replaceDoc: (doc: SyncDoc) => void;
  paused: () => boolean;
  locked: () => boolean;
  running: () => Promise<void> | null;
  loading: () => Promise<void> | null;
  cyclesDone: (report: (error: unknown) => void) => Promise<void>;
  retire: () => Promise<void>;
  clearTimers: () => void;
  persist: () => Promise<void>;
  forgetAdapters: () => void;
  startOver: () => void;
  publish: (patch: Partial<SyncUi>) => void;
};

export function syncStopper(steps: StopSteps) {
  let stopping = false;

  async function stopSync(consent: ConsentToken | null, { deleteData = false } = {}) {
    const native = steps.native();
    if (!native || !steps.doc().enabled) return;
    stopping = true;
    try {
      await steps.running()?.catch(() => {});
      const wasPaused = steps.paused();
      if (!wasPaused) await steps.loading()?.catch(() => {});
      steps.clearTimers();
      const reportFailure = (error: unknown) => warnFor(consent, "[sync] the last cycle before stopping failed", error);
      await steps.cyclesDone(reportFailure);
      if (!wasPaused && !steps.locked()) await steps.retire().catch(reportFailure);
      steps.clearTimers();
      const { folder, deviceId, types } = steps.doc();
      if (deleteData && folder && !wasPaused) await native.deleteChain(folder).catch((error: unknown) => warnFor(consent, "[sync] deleting sync data failed", error));
      steps.replaceDoc({ ...emptyDoc(), folder, types });
      await steps.persist().catch((error: unknown) => warnFor(consent, "[sync] couldn't save that sync is off", error));
      if (deviceId) await native.forget(deviceId);
      steps.forgetAdapters();
      steps.startOver();
      steps.publish({ status: "off", error: null });
    } finally {
      stopping = false;
    }
  }

  return { stopSync, stopping: () => stopping };
}
