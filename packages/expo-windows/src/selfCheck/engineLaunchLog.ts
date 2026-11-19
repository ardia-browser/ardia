import { engineAvailable, hostCall } from "../engine/host";
import { expectEqual, type Check } from "./check";

const LINES = 3000;
const IN_FLIGHT = 100;
const numbered = (i: number) => String(i).padStart(4, "0");

const launchLogChecks: Check[] = [
  {
    name: "launch log: the app and the engine each write 3,000 numbered lines at once (the smoke script then requires every line whole and present)",
    run: async () => {
      let answered = 0;
      let batch: Promise<unknown>[] = [];
      for (let i = 0; i < LINES; i++) {
        batch.push(hostCall("tab.close", { key: `launch-log-race-${numbered(i)}` }).then(() => answered++));
        console.info(`[ardia windows] launch log race app ${numbered(i)}`);
        if (batch.length >= IN_FLIGHT) {
          await Promise.all(batch);
          batch = [];
        }
      }
      await Promise.all(batch);
      console.info(`[ardia windows] launch log race wrote ${LINES} app lines and asked the engine for ${LINES}`);
      expectEqual(answered, LINES, "every engine call that logs a numbered line answered");
    },
  },
];

export const checks: Check[] = engineAvailable() ? launchLogChecks : [];
