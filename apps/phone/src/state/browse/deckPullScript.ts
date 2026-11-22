import { runOnUI } from "react-native-reanimated";
import { labLog } from "../../platform/lab";
import { currentTabs } from "../tabs/store";
import { sendDeckCommand } from "./deckCommands";
import { deckPullArmed, deckStandbyId, replayDeckPull, type PullPath } from "./deckPull";
import { deckPullBegan, deckPullReleased, deckPullSettled, useBrowse, type Surface } from "./store";
import { t } from "../../lib/uiLanguage";


export const DECK_PULL_SCRIPT = {
  startMs: 2500,
  readyMs: 20_000,
  pollMs: 100,
  settleMs: 1500,
  maxPulls: 50,
  commits: { travel: 220, ms: 350, velocityY: -630 } satisfies PullPath,
  returns: { travel: 50, ms: 350, velocityY: 0 } satisfies PullPath,
} as const;

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function until(test: () => boolean, capMs: number): Promise<boolean> {
  for (let waited = 0; waited < capMs; waited += DECK_PULL_SCRIPT.pollMs) {
    if (test()) return true;
    await wait(DECK_PULL_SCRIPT.pollMs);
  }
  return test();
}

const surfaceIs = (surface: Surface) => () => useBrowse.getState().surface === surface;

function pullablePage(): string | null {
  const id = currentTabs().selectedId;
  return id && useBrowse.getState().surface === "browsing" && deckPullArmed() === id && deckStandbyId() === id ? id : null;
}

function replay(id: string, path: PullPath): Promise<"landed" | "returned" | "refused"> {
  return new Promise((done) => {
    runOnUI(replayDeckPull)(
      id,
      path,
      () => deckPullBegan(id),
      (lands) => deckPullReleased(id, lands),
      (settledId, landed, worstFrameMs) => {
        deckPullSettled(settledId, landed, worstFrameMs);
        done(landed ? "landed" : "returned");
      },
      () => done("refused"),
    );
  });
}

export async function runDeckPullScript(times: number, log: (line: string) => void = labLog) {
  const pulls = Math.min(Math.max(Math.trunc(times), 0), DECK_PULL_SCRIPT.maxPulls);
  await wait(DECK_PULL_SCRIPT.startMs);
  let committed = 0;
  for (let round = 0; round < pulls; round++) {
    if (!(await until(() => pullablePage() !== null, DECK_PULL_SCRIPT.readyMs))) break;
    const id = pullablePage();
    if (!id) break;
    log(`PAGELAB deck pull script: pull ${round + 1} of ${pulls}`);
    const ended = await replay(id, DECK_PULL_SCRIPT.commits);
    if (ended !== "landed" || !(await until(surfaceIs("deck"), DECK_PULL_SCRIPT.settleMs))) {
      log(`PAGELAB deck pull script: pull ${round + 1} ${ended}, the deck did not open`);
      break;
    }
    committed += 1;
    await wait(DECK_PULL_SCRIPT.settleMs);
    sendDeckCommand({ kind: "openSelected" });
    if (!(await until(surfaceIs("browsing"), DECK_PULL_SCRIPT.readyMs))) break;
    await wait(DECK_PULL_SCRIPT.settleMs);
  }
  let returned = 0;
  if (await until(() => pullablePage() !== null, DECK_PULL_SCRIPT.readyMs)) {
    const id = pullablePage();
    if (id) {
      log(t(`PAGELAB deck pull script: early release`));
      if ((await replay(id, DECK_PULL_SCRIPT.returns)) === "returned") returned = 1;
      await wait(DECK_PULL_SCRIPT.settleMs);
    }
  }
  log(`PAGELAB deck pull script done: ${committed} of ${pulls} committed, ${returned} returned${committed === 0 && returned === 0 ? ", no page was showing with the deck waiting" : ""}`);
}
