import { startRebase } from "../../platform/sync";
import { newId } from "../browser/model";
import type { SyncDoc } from "./syncDoc";

const unsaved = new WeakSet<SyncDoc>();

export function oweRebase(doc: SyncDoc, names: string[], recovery = newId("rb")) {
  for (const name of names) {
    const scoped = doc.scopes[name];
    if (scoped) startRebase(scoped, recovery);
  }
  doc.rebaseScopes = { ...doc.rebaseScopes, ...Object.fromEntries(names.map((name) => [name, recovery])) };
  unsaved.add(doc);
}

export const takeUnsavedObligations = (doc: SyncDoc) => unsaved.delete(doc);
