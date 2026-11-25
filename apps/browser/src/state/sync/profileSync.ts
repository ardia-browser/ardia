import { type Adapter, type ExtensionsAdapter } from "../../platform/sync";
import { useBrowser } from "../browser/store";
import { bookmarksAdapter, inTodaysNames, passwordsAdapter } from "./adapters";
import { historyAdapter } from "./historyAdapter";
import { profileOpened } from "../profiles/profileLoading";
import { extensionsAdapterFor, watchExtensionIntents } from "./extensions";
import { typeSyncedFor, type DataType, type SyncDoc } from "./syncDoc";
import { dataOwnerMatches } from "./spaceLinks";

export function createProfileSync(current: () => SyncDoc) {
  const owners = new Map<string, { engineId: string; passwords: (forced: boolean) => Adapter; extensions: ExtensionsAdapter }>();
  const enabled = (profileId: string, type: DataType, engineId: string) => {
    const doc = current();
    const link = doc.profiles[profileId];
    return !doc.preview && doc.enabled && !!link?.enabled && !link.retire && typeSyncedFor(doc.types, type, true) &&
      useBrowser.getState().profiles[profileId]?.engineId === engineId && dataOwnerMatches(doc, profileId);
  };
  function of(profileId: string, engineId: string) {
    const cached = owners.get(profileId);
    if (cached?.engineId === engineId) return cached;
    const entry = {
      engineId,
      passwords: passwordsAdapter(profileId, undefined, () => engineId, () => enabled(profileId, "passwords", engineId)),
      extensions: extensionsAdapterFor(profileId, () => engineId, () => enabled(profileId, "extensions", engineId)),
    };
    owners.set(profileId, entry);
    return entry;
  }

  function adapters(profileId: string, forced: boolean): Adapter[] {
    const profile = useBrowser.getState().profiles[profileId];
    if (!profile) return [];
    const { engineId } = profile;
    const context = (type: DataType) => ({ profileId, engineId, enabled: () => enabled(profileId, type, engineId) });
    const { passwords, extensions } = of(profileId, engineId);
    return [
      ...(enabled(profileId, "bookmarks", engineId) ? [inTodaysNames(bookmarksAdapter(profileId, context("bookmarks")))] : []),
      ...(enabled(profileId, "history", engineId) ? [inTodaysNames(historyAdapter(profileId, context("history")))] : []),
      ...(enabled(profileId, "passwords", engineId) ? [passwords(forced)] : []),
      ...(enabled(profileId, "extensions", engineId) ? [extensions] : []),
    ];
  }

  function watchExtensions() {
    const profiles = Object.values(useBrowser.getState().profiles).filter(({ id, engineId }) => profileOpened(engineId) && enabled(id, "extensions", engineId)).map(({ engineId }) => engineId);
    if (profiles.length) watchExtensionIntents(profiles);
  }

  function extensionsOf(profileId: string) {
    const current = useBrowser.getState().profiles[profileId];
    return current && enabled(profileId, "extensions", current.engineId) && profileOpened(current.engineId) ? of(profileId, current.engineId).extensions : undefined;
  }

  return { adapters, watchExtensions, extensionsOf, clear: () => owners.clear() };
}
