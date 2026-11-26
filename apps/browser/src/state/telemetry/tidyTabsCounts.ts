import { consentOrNow, countFor, type ConsentToken } from "./consentPeriod";

let runs = 0;
let moved = 0;
let undos = 0;
let duplicateCloses = 0;
let duplicatesClosed = 0;
let duplicateUndos = 0;

export function noteTidyTabsRun(tabsMoved: number) {
  runs++;
  moved += tabsMoved;
}

export const noteTidyTabsUndo = () => undos++;

export function noteDuplicateTabsClosed(tabs: number, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => {
    duplicateCloses++;
    duplicatesClosed += tabs;
  });
}

export function noteDuplicateTabsUndo(consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void duplicateUndos++);
}

export function takeTidyTabsCounts() {
  const taken = {
    tidy_tabs_runs: runs,
    tidy_tabs_moved: moved,
    tidy_tabs_undos: undos,
    duplicate_tabs_closes: duplicateCloses,
    duplicate_tabs_closed: duplicatesClosed,
    duplicate_tabs_undos: duplicateUndos,
  };
  runs = 0;
  moved = 0;
  undos = 0;
  duplicateCloses = 0;
  duplicatesClosed = 0;
  duplicateUndos = 0;
  return taken;
}
