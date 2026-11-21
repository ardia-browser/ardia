import "../../platform/copy";
import type { ImportOutcome } from "../legacy/importer";
import { importOldApp, startWithoutOldApp } from "../legacy/upgrade";
import { keepWaitingLinks, listenForLinks } from "../links/links";
import { useBoot } from "./bootState";
import { launchArguments } from "./launchFlags";

export { useBoot };

let begin: (() => void) | null = null;

export function bootApp(start: () => void) {
  if (begin) return;
  begin = start;
  listenForLinks();
  if (launchArguments().isDemo) finish("none");
  else void attempt();
}

async function attempt() {
  useBoot.setState({ busy: true });
  const result = await importOldApp();
  if (result.kind === "ready") finish(result.outcome);
  else {
    useBoot.setState((state) => ({ failures: state.failures + 1, busy: false }));
    keepWaitingLinks();
  }
}

function finish(outcome: ImportOutcome) {
  if (useBoot.getState().ready || !begin) return;
  begin();
  useBoot.setState({ ready: true, busy: false, outcome });
}

export function retryImport() {
  const state = useBoot.getState();
  if (state.ready || state.busy || !begin) return;
  void attempt();
}

export async function startWithoutImporting() {
  const state = useBoot.getState();
  if (state.ready || state.busy || !begin) return;
  useBoot.setState({ busy: true });
  if (await startWithoutOldApp()) finish("startedFresh");
  else useBoot.setState((s) => ({ failures: s.failures + 1, busy: false }));
}
