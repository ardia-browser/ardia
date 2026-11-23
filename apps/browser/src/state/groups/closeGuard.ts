import type { ConsentToken } from "../telemetry/consentPeriod";
import type { BrowserState } from "../browser/store";

type CloseGuard = (windowId: string, groupId: string) => Promise<boolean>;

let guard: CloseGuard = async () => true;

export const guardGroupClose = (check: CloseGuard) => void (guard = check);

export const groupCloseAllowed = (windowId: string, groupId: string) => guard(windowId, groupId);

type KeptCheck = (groupId: string, s?: Pick<BrowserState, "groups">) => boolean;

let kept: KeptCheck = () => false;

export const keepGroupsOpen = (check: KeptCheck) => void (kept = check);

export const groupKeptOpen: KeptCheck = (groupId, s) => kept(groupId, s);

type DropNote = (answer: "asked" | "confirmed", consent: ConsentToken | null) => void;

let dropNote: DropNote = () => {};

export const countKeptGroupDrops = (note: DropNote) => void (dropNote = note);

export const noteKeptGroupDrop: DropNote = (answer, consent) => dropNote(answer, consent);
