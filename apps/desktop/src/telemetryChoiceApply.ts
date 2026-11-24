import { setSharing } from "../../browser/src/state/telemetry/client";
import { dismissAsk } from "../../browser/src/state/telemetry/choice";
import { adoptInstallId } from "../../browser/src/state/telemetry/installId";
import type { ChoiceChange } from "../../browser/src/state/telemetry/relay";
import { startWatch, stopWatch, watchNoticeShown } from "../../browser/src/state/telemetry/watch";
import { documentSaved } from "../../browser/src/platform/documents";

const STATE_DOC = "telemetry.json";

export async function applyChoiceDurably(change: ChoiceChange): Promise<boolean> {
  if (change.kind === "sharing") {
    const off = setSharing(change.on, change.source, change.placement);
    if (!change.on) return off;
    await documentSaved(STATE_DOC);
    return true;
  }
  if (change.kind === "askDismissed") dismissAsk();
  else if (change.kind === "watchStarted") startWatch(change.reportId, change.days);
  else if (change.kind === "watchStopped") stopWatch();
  else if (change.kind === "watchNoticeShown") watchNoticeShown();
  else adoptInstallId(change.id);
  await documentSaved(STATE_DOC);
  return true;
}

export function followerChoiceSaved(request: Promise<unknown>, refresh: () => Promise<void>, report: (error: unknown) => void): Promise<boolean> {
  return request.then(
    (saved) => refresh().then(() => saved === true),
    (error: unknown) => (report(error), refresh().then(() => false)),
  );
}
