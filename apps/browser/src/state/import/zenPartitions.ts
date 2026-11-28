import type { ImportKind, ImportResult } from "../../platform/importModule";
import { confirm } from "../app/system";
import { engineProfile, plural } from "../browser/model";
import { useBrowser } from "../browser/store";
import { createProfile } from "../profiles/actions";
import type { ConsentToken } from "../telemetry/choice";
import { applyResult, importNative, importPasswords, profileColorFor, profileNamed, type ImportCounts } from "./apply";
import type { FallbackContainer } from "./sidebarPlan";

export type ZenStoreLock = { owners: Map<string, string>; key: string };

export type DestinationOptions = {
  color?: string;
  emoji?: string;
  shareWith?: string | null;
  shareTopApps?: boolean;
  storeLock?: ZenStoreLock;
};

function canReplaceProfile(clash: string | undefined, shareWith: string | null | undefined, lock?: ZenStoreLock): clash is string {
  if (!clash) return false;
  if (!lock) return true;
  const store = engineProfile(useBrowser.getState(), clash);
  const owner = lock.owners.get(store);
  if (owner && owner !== lock.key) return false;
  return !shareWith || store === engineProfile(useBrowser.getState(), shareWith);
}

function claimProfileStore(profileId: string, lock?: ZenStoreLock) {
  if (lock) lock.owners.set(engineProfile(useBrowser.getState(), profileId), lock.key);
}

export async function resolveDestination(
  target: string,
  index: number,
  name: string,
  signal: AbortSignal,
  options: DestinationOptions = {},
): Promise<string> {
  const { color, emoji, shareWith, shareTopApps, storeLock } = options;
  if (index === 0) {
    claimProfileStore(target, storeLock);
    return target;
  }
  const clash = profileNamed(name);
  if (canReplaceProfile(clash, shareWith, storeLock)) {
    const { confirmed } = await confirm({
      title: "Import as new profile?",
      message:
        "Import this data as a new profile to avoid data loss. If you replace a profile, your passwords, cookies, and payment info will be replaced, while your bookmarks and history will be combined.",
      confirmTitle: "Import as new profile",
      cancelTitle: "Replace this profile",
    });
    if (signal.aborted) return target;
    if (!confirmed) {
      claimProfileStore(clash, storeLock);
      return clash;
    }
  }
  const created = createProfile({ name, color: profileColorFor(color), icon: emoji ?? null, shareWith, shareTopApps });
  claimProfileStore(created, storeLock);
  return created;
}

export function droppedContainerCookiesNote(
  result: Pick<ImportResult, "containerVaultTokens" | "containerCookieCounts">,
  held: ReadonlySet<string>,
  fallbackContainer?: FallbackContainer,
): string | null {
  let dropped = 0;
  for (const [container, token] of Object.entries(result.containerVaultTokens ?? {})) {
    if (held.has(token)) dropped += result.containerCookieCounts?.[container] ?? 0;
  }
  if (dropped <= 0) return null;
  const verb = dropped === 1 ? "wasn't" : "weren't";
  return fallbackContainer === "ambiguous"
    ? `${plural(dropped, "cookie")} from Zen containers ${verb} imported: include Tabs so each container gets its own profile.`
    : `${plural(dropped, "cookie")} from other Zen containers ${verb} imported.`;
}

export type ZenPartitionImport = {
  dest: string;
  members: string[][];
  containers: number[];
  dataPartition: number;
  fallbackContainer?: FallbackContainer;
  result: ImportResult;
  browserName: string;
  requested: ImportKind[];
  onFailed?: (kind: ImportKind) => void;
  consent?: ConsentToken | null;
  signal?: AbortSignal;
  held: Set<string>;
  writtenStores: Set<string>;
};

export async function applyZenPartitions({
  dest,
  members,
  containers,
  dataPartition,
  fallbackContainer,
  result,
  browserName,
  requested,
  onFailed,
  consent,
  signal,
  held,
  writtenStores,
}: ZenPartitionImport): Promise<ImportCounts> {
  const tokenFor = (container: number | "ambiguous") =>
    container === 0 ? result.vaultToken : typeof container === "number" && container > 0 ? result.containerVaultTokens?.[String(container)] : undefined;
  const dataContainer = containers[dataPartition] ?? fallbackContainer ?? 0;
  const dataToken = tokenFor(dataContainer);
  const destStore = engineProfile(useBrowser.getState(), dest);
  const destFresh = !writtenStores.has(destStore);
  writtenStores.add(destStore);
  const savedPasswords = new Set<number>();
  const primaryRequested = !destFresh
    ? requested.filter((k) => k !== "passwords" && k !== "cookies" && k !== "autofill")
    : dataContainer !== 0
      ? requested.filter((k) => k !== "autofill")
      : requested;
  const counts = await applyResult(
    dest,
    { ...result, favorites: [], vaultToken: destFresh ? dataToken : undefined, credentials: [] },
    browserName,
    primaryRequested,
    onFailed,
    consent,
    signal,
    held,
  );
  if (!signal?.aborted && destFresh && requested.includes("passwords") && result.credentials.length) {
    const pw = await importPasswords(dest, result.credentials, { signal, savedIndices: savedPasswords });
    if (!signal?.aborted && pw.failed > 0) onFailed?.("passwords");
  }
  if (!signal?.aborted && destFresh && dataContainer !== 0 && result.vaultToken && requested.includes("autofill") && held.has(result.vaultToken)) {
    const w = await importNative(dest, result.vaultToken, ["autofill"], onFailed, held);
    counts.addresses += w.addresses;
    counts.cards += w.cards;
  }
  for (let p = 0; p < containers.length; p++) {
    if (signal?.aborted) break;
    if (p === dataPartition) continue;
    const target = members[p]?.[0];
    if (!target) continue;
    const store = engineProfile(useBrowser.getState(), target);
    if (writtenStores.has(store)) continue;
    writtenStores.add(store);
    if (requested.includes("cookies")) {
      const token = tokenFor(containers[p]!);
      if (token) {
        const w = await importNative(target, token, ["cookies"], onFailed, held);
        counts.cookies += w.cookies;
      }
    }
    if (!signal?.aborted && requested.includes("passwords") && result.credentials.length) {
      const pw = await importPasswords(target, result.credentials, { signal, recordTelemetry: false, savedIndices: savedPasswords });
      if (!signal?.aborted && pw.failed > 0) onFailed?.("passwords");
    }
  }
  counts.passwords += savedPasswords.size;
  return counts;
}
