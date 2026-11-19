import { readDocument, removeDocument } from "../../platform/documents";
import type { BrowserState } from "../browser/store";
import type { ConsentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";

export function removeLegacyFaviconFiles(s: Pick<BrowserState, "profiles">, consent: ConsentToken | null) {
  for (const id of Object.keys(s.profiles)) {
    const doc = `favicons-${id}.json`;
    try {
      if (readDocument(doc) === null) continue;
      removeDocument(doc);
    } catch (error) {
      warnFor(consent, `[favicons] couldn't remove ${doc}`, error);
    }
  }
}
