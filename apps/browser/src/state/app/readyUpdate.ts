import { create } from "zustand";
import { onReadyUpdate, restartToUpdate as restartNative, updaterState, type ReadyUpdate } from "../../platform/app";
import { openReleaseNotesPage } from "../releaseNotes/releaseNotesPage";
import { showMenu } from "./system";
import { noteReadyUpdate } from "../telemetry/usage";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";

export type { ReadyUpdate } from "../../platform/app";

export const useReadyUpdateState = create<{ ready: ReadyUpdate | null; onQuitBuild: string | null }>()(() => ({ ready: null, onQuitBuild: null }));

export const useReadyUpdate = () => useReadyUpdateState((s) => (s.ready && s.ready.build !== s.onQuitBuild ? s.ready : null));

function restartWith(consent: ConsentToken | null) {
  noteReadyUpdate("restart", consent);
  void restartNative().catch((error) => warnFor(consent, "[readyUpdate] restart", error));
}

export const restartToUpdate = () => restartWith(consentToken());

export async function openReadyUpdateMenu(windowId: string | null) {
  const ready = useReadyUpdateState.getState().ready;
  if (!ready) return;
  const consent = consentToken();
  const choice = await showMenu([
    { id: "restart", title: `Restart to Update to ${ready.displayVersion}`, symbol: "arrow.clockwise.circle" },
    { id: "notes", title: "Release Notes", symbol: "doc.text" },
    { separator: true },
    { id: "onQuit", title: "Install When I Quit", symbol: "eye.slash" },
  ]);
  if (choice === "restart") restartWith(consent);
  else if (choice === "notes") openReleaseNotesPage(windowId, ready.version);
  else if (choice === "onQuit") {
    noteReadyUpdate("onQuit", consent);
    useReadyUpdateState.setState({ onQuitBuild: ready.build });
  }
}

let started = false;
const countedBuilds = new Set<string>();

function setReady(ready: ReadyUpdate | null, consent: ConsentToken | null) {
  useReadyUpdateState.setState({ ready });
  if (!ready || ready.build === useReadyUpdateState.getState().onQuitBuild || countedBuilds.has(ready.build)) return;
  countedBuilds.add(ready.build);
  noteReadyUpdate("shown", consent);
}

export function startReadyUpdate() {
  if (started) return;
  started = true;
  const consent = consentToken();
  let heard = false;
  onReadyUpdate((ready) => {
    heard = true;
    setReady(ready, consentToken());
  });
  void updaterState()
    .then((state) => {
      if (!heard && state.available) setReady(state.ready ?? null, consent);
    })
    .catch((error) => warnFor(consent, "[readyUpdate] state", error));
}
