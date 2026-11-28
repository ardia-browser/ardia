import { useEffect } from "react";
import { emptyCounts, type ImportKind } from "../../state/import/apply";
import { importSafariDirect, importSafariExport } from "../../state/import/fileImports";
import { backTo, chooseSource, closeImport, NO_EXTENSIONS, patchImport, pickSources, setImportKinds, type ImportFlow } from "../../state/import/flow";
import {
  chooseAllConflicts,
  chooseConflictVersion,
  closeConflictList,
  currentChoices,
  handChanges,
  importChosenPasswords,
  openConflictList,
  pickConflictVersions,
  setConflictFilter,
} from "../../state/import/importOutcome";
import { continueImport, skipEncryptedData, skipSource, unlockAndImport } from "../../state/import/runImport";
import { openListedExtensionsInStore } from "../../state/import/listedExtensions";
import { takeOfferedEngine } from "../../state/import/searchEngine";
import { devRegister } from "../dev/devRegister";

export function useImportDevHandle(flow: ImportFlow) {
  useEffect(() => {
    const { step } = flow;
    const done = step.name === "done" ? step : null;
    const conflicts = step.name === "conflicts" ? step : null;
    const chosen = conflicts ? currentChoices(conflicts) : {};
    return devRegister("acImport", null, {
      select: (id: string) => {
        const b = flow.browsers.find((x) => x.id === id);
        if (b) chooseSource(b);
        return !!b;
      },
      pick: (ids: string[]) => pickSources(ids),
      picked: flow.picked,
      run: flow.run ? { ids: flow.run.ids, at: flow.run.at, finished: flow.run.outcomes.map((o) => ({ id: o.source.id, skipped: o.skipped })) } : null,
      skip: () => skipSource(flow.turn),
      turn: flow.turn,
      next: () => {
        const { name } = step;
        if (name === "choose" || name === "profiles") continueImport(name, flow.turn);
      },
      conflicts: conflicts
        ? {
            count: conflicts.conflicts.length,
            view: conflicts.view,
            pick: conflicts.pick,
            filter: conflicts.filter,
            saving: conflicts.saving,
            changed: handChanges(conflicts.view === "list" ? conflicts.draft : conflicts.custom),
            rows: conflicts.conflicts.map((c) => ({ id: c.id, site: c.site, username: c.username, versions: c.versions, choice: chosen[c.id] ?? null })),
          }
        : null,
      chooseConflicts: (pick: string) => conflicts && pickConflictVersions(pick, conflicts.token),
      letMeChoose: () => conflicts && openConflictList(conflicts.token),
      filterConflicts: (text: string) => conflicts && setConflictFilter(text, conflicts.token),
      chooseConflict: (id: string, browserId: string) => conflicts && chooseConflictVersion(id, browserId, conflicts.token),
      chooseAllConflicts: (browserId: string) => conflicts && chooseAllConflicts(browserId, conflicts.token),
      doneChoosing: () => conflicts && closeConflictList(conflicts.token),
      importPasswords: () => (conflicts ? importChosenPasswords(conflicts.token) : Promise.resolve()),
      back: () => backTo("choose", flow.turn),
      unlock: () => unlockAndImport(flow.turn),
      skipEncrypted: () => skipEncryptedData(flow.turn),
      importSafariDirect: () => importSafariDirect(flow.turn),
      importSafari: (path: string) => importSafariExport(path, flow.turn),
      close: closeImport,
      openListedExtensions: openListedExtensionsInStore,
      kinds: [...flow.kinds],
      setKinds: (list: ImportKind[]) => setImportKinds(list),
      setSpaces: (spaces: string[]) => patchImport({ spaces }),
      setSourceProfiles: (sourceProfiles: string[]) => patchImport({ sourceProfiles }),
      browsers: flow.source ? flow.source.profiles.map((p) => ({ id: p.id, name: p.name, spaces: p.spaces ?? [] })) : [],
      counts: done?.counts ?? emptyCounts(),
      sources: done?.sources ?? [],
      failures: done?.failures ?? [],
      extensions: done?.extensions ?? NO_EXTENSIONS,
      notes: done?.notes ?? [],
      searchEngine: done?.searchEngine ? { name: done.searchEngine.name, offered: done.searchEngine.offered } : null,
      takeOfferedEngine,
      step: step.name,
      error: "error" in step ? step.error : null,
      status: step.name === "progress" ? step.status : {},
      preparing: step.name === "progress" ? step.preparing : 1,
      source: flow.source?.id ?? null,
      sourceProfiles: flow.sourceProfiles,
      spaces: flow.spaces,
      fullDiskAccess: flow.fullDiskAccess,
    });
  });
}
