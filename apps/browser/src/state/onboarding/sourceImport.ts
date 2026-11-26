import { onWindowEvent } from "../../platform/windows";
import { importNow, type ImportFlow } from "../import/flow";
import { IMPORT_WINDOW_ID } from "../settings/settingsWindows";

export const importSucceeded = (flow: ImportFlow) => flow.step.name === "done" && flow.step.failures.length === 0;

export const importFailed = (flow: ImportFlow) => flow.step.name === "done" && flow.step.failures.length > 0;

export const importedFrom = (flow: ImportFlow) => (importSucceeded(flow) ? (flow.source?.name ?? null) : null);

export function watchImportEnd(onAbandoned: () => void): () => void {
  const watch = onWindowEvent((e) => {
    if (e.type === "close" && e.id === IMPORT_WINDOW_ID && !importSucceeded(importNow())) onAbandoned();
  });
  return () => watch.remove();
}
