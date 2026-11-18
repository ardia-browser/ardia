import { repoKey } from "./rows";
import { live, setRepoHidden, updateFolder } from "./store";
import type { LiveItem } from "./types";

export function folderRepos(folderId: string): string[] {
  const s = live();
  const listed = [...(s.items[folderId] ?? []), ...(s.hidden[folderId] ?? []), ...(s.repoHidden[folderId] ?? [])].flatMap((it) => repoKey(it) ?? []);
  const folder = s.folders[folderId];
  return [...new Set([...listed, ...(folder?.hiddenRepos ?? []), ...(folder?.shownRepos ?? [])])];
}

export function showAllRepos(folderId: string) {
  updateFolder(folderId, { hiddenRepos: [], shownRepos: live().folders[folderId]?.showNewRepos ? [] : folderRepos(folderId) });
}

export function setShowNewRepos(folderId: string, showNewRepos: boolean) {
  const folder = live().folders[folderId];
  if (!folder) return;
  updateFolder(folderId, { showNewRepos, shownRepos: showNewRepos ? [] : folderRepos(folderId).filter((r) => !folder.hiddenRepos.includes(r)) });
}

export function hideNewRepos(folderId: string, fetched: LiveItem[]) {
  const folder = live().folders[folderId];
  if (!folder || folder.showNewRepos) return;
  const known = new Set([...folder.shownRepos, ...folder.hiddenRepos]);
  const fresh = [...new Set(fetched.flatMap((it) => repoKey(it) ?? []))].filter((r) => !known.has(r));
  fresh.forEach((repo) => setRepoHidden(folderId, repo, true));
}
