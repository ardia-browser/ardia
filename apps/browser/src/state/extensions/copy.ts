import { applyExtensionsSync, extensionsSyncState, listExtensions } from "../../platform/extensions";
import { confirm, showMenu } from "../app/system";
import { engineProfile } from "../browser/model";
import { useBrowser } from "../browser/store";
import { openProfile } from "../profiles/profileLoading";
import { refreshExtensions } from "./actions";

export type CopyResult = { started: number; already: number; failed: number };

export async function copyExtensions(source: string, targets: string[], only?: string): Promise<CopyResult> {
  const { extensions } = await extensionsSyncState(source);
  const wanted = extensions.filter((e) => e.syncable && (!only || e.id === only));
  const result: CopyResult = { started: 0, already: 0, failed: 0 };
  for (const target of targets) {
    openProfile(target);
    const have = new Set((await listExtensions(target)).map((x) => x.id));
    for (const e of wanted) {
      if (!e.syncable) continue;
      if (have.has(e.id)) {
        result.already++;
        continue;
      }
      const approval = e.approved ? { approval: { v: e.version, fps: [e.fingerprint] } } : {};
      try {
        const { state } = await applyExtensionsSync(target, { id: e.id, record: { on: e.enabled, inc: e.incognito, pin: e.pinned }, ...approval });
        if (state === "pending" || state === "installed" || state === "updating") result.started++;
        else result.failed++;
      } catch {
        result.failed++;
      }
    }
    for (const ms of [3000, 10000, 30000]) setTimeout(() => void refreshExtensions(target), ms);
  }
  return result;
}

const summary = ({ started, already, failed }: CopyResult) =>
  [
    started ? `${started} installing from the Chrome Web Store.` : "",
    already ? `${already} already there, left as they are.` : "",
    failed ? `${failed} couldn't be copied.` : "",
  ]
    .filter(Boolean)
    .join(" ") || "There was nothing to copy.";

export async function copyExtensionsToProfiles(source: string, only?: string) {
  const s = useBrowser.getState();
  const targets = s.profileOrder
    .map((id) => ({ engine: engineProfile(s, id), name: s.profiles[id]!.name }))
    .filter((t, i, all) => t.engine !== source && all.findIndex((o) => o.engine === t.engine) === i);
  if (!targets.length) return;
  const choice = await showMenu([
    ...targets.map((t) => ({ id: t.engine, title: t.name })),
    ...(targets.length > 1 ? [{ separator: true as const }, { id: "all", title: "All Other Profiles" }] : []),
  ]);
  if (!choice) return;
  const result = await copyExtensions(source, choice === "all" ? targets.map((t) => t.engine) : [choice], only).catch(() => null);
  await confirm({ title: "Copy Extensions", message: result ? summary(result) : "Extensions couldn't be copied.", confirmTitle: "OK", cancelTitle: "" });
}

export const hasOtherProfiles = (source: string) => {
  const s = useBrowser.getState();
  return s.profileOrder.some((id) => engineProfile(s, id) !== source);
};
