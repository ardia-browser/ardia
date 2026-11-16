import { engineAvailable } from "../engine/host";
import { expectTrue, type Check } from "./check";
import { evaluate, hide, LEFT, listed, pause, show, until, withPages } from "./engineSleep";

const SIGNAL_MS = 8000;
const STILL_WAITING_MS = 3000;

const navigationChecks: Check[] = [
  {
    name: "engine sleep: a hidden page's navigation in flight is listed as loading until its answer comes, which the sweep skips on",
    run: () =>
      withPages(["navigation"], async ([page], windowId) => {
        await show(page!, windowId, LEFT);
        await hide(page!, windowId);
        await evaluate(page!, `setTimeout(() => { location.href = "/hold?navigation"; }, 0); post("result", "null");`);
        await until("the hidden page reports its navigation as loading", SIGNAL_MS, () => listed(page!), (tab) => tab?.loading === true);
        await pause(STILL_WAITING_MS);
        const waiting = await listed(page!);
        expectTrue(waiting?.loading === true && waiting?.discarded !== true, `while the answer is held the page is still listed loading (${JSON.stringify(waiting)})`);
      }),
  },
];

export const checks: Check[] = engineAvailable() ? navigationChecks : [];
