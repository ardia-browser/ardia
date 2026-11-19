import { takeLiveGithubCounts } from "./liveGithub";
import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

const NONE = {
  live_folder_color_picks: 0,
  live_completed_tabs_closed: 0,
  live_row_hides: 0,
  live_stack_hides: 0,
  live_repo_menu_picks: 0,
  live_repo_hide_alls: 0,
  live_new_repos_hidden_turned_on: 0,
  live_account_connects: 0,
  live_account_connects_beside_another_profile: 0,
  live_legacy_account_copies: 0,
  live_legacy_account_copy_refusals: 0,
};

export type LiveFolderCount = keyof typeof NONE;

let counts = { ...NONE };

export function noteLiveFolders(count: LiveFolderCount, by = 1, consent?: ConsentToken | null) {
  countFor(consent, () => void (counts[count] += by), { [count]: by });
}

export function noteLiveRepoMenuPick(choice: string, showNewRepos: boolean) {
  noteLiveFolders("live_repo_menu_picks");
  if (choice === "repos:none") noteLiveFolders("live_repo_hide_alls");
  if (choice === "repos:new" && !showNewRepos) noteLiveFolders("live_new_repos_hidden_turned_on");
}

export function noteLiveFolderColorPick(consent?: ConsentToken | null) {
  noteLiveFolders("live_folder_color_picks", 1, consent);
}

export function takeLiveFolderCounts() {
  const taken = counts;
  counts = { ...NONE };
  return { ...taken, ...takeLiveGithubCounts() };
}
