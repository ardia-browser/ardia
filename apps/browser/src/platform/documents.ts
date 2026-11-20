import { nativeModule, type BangListReply } from "@ardia/shell";
import { upgradeWorkspaceDocuments } from "../lib/workspaceUpgrade";

const Documents = nativeModule("ArdiaDocuments");
const nativeRead = (name: string) => Documents.readDocument(name);
const nativeWrite = (name: string, contents: string) => Documents.writeDocument(name, contents);
const writeDocumentImmediately = (name: string, contents: string) => {
  if (Documents.writeDocumentImmediately(name, contents) === false) throw new Error(`Couldn’t save ${name} during the workspace upgrade.`);
};
const nativeSave = (name: string, contents: string) => Documents.saveDocument(name, contents);
const nativeRemove = (name: string) => Documents.removeDocument(name);
export const fetchBangList = (etag: string | null): Promise<BangListReply> => nativeModule("ArdiaShell").fetchBangList(etag);

let checked = false;
let failure: string | null = null;

function ensureWorkspace() {
  if (!checked) {
    checked = true;
    try { upgradeWorkspaceDocuments({ read: nativeRead, write: writeDocumentImmediately }); }
    catch (error) { failure = String(error instanceof Error ? error.message : error); }
  }
  if (failure) throw new Error(failure);
}

export const workspaceUpgradeError = () => {
  try { ensureWorkspace(); } catch {}
  return failure;
};
export function readDocument(name: string) { ensureWorkspace(); return nativeRead(name); }
export function writeDocument(name: string, contents: string) { ensureWorkspace(); nativeWrite(name, contents); }

export function saveDocument(name: string, contents: string) { ensureWorkspace(); return nativeSave(name, contents); }
export function documentSaved(name: string) { ensureWorkspace(); return Documents.documentSaved(name); }
export function removeDocument(name: string) { ensureWorkspace(); return nativeRemove(name); }
