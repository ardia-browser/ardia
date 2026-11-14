let rowHides = 0;
let stackHides = 0;
let repoMenuPicks = 0;
let repoHideAlls = 0;
let newReposHiddenTurnedOn = 0;

export function noteLiveRowHide() {
  rowHides++;
}

export function noteLiveStackHide() {
  stackHides++;
}

export function noteLiveRepoMenuPick(choice: string, showNewRepos: boolean) {
  repoMenuPicks++;
  if (choice === "repos:none") repoHideAlls++;
  if (choice === "repos:new" && !showNewRepos) newReposHiddenTurnedOn++;
}

export function takeLiveHideCounts() {
  const taken = {
    live_row_hides: rowHides,
    live_stack_hides: stackHides,
    live_repo_menu_picks: repoMenuPicks,
    live_repo_hide_alls: repoHideAlls,
    live_new_repos_hidden_turned_on: newReposHiddenTurnedOn,
  };
  rowHides = 0;
  stackHides = 0;
  repoMenuPicks = 0;
  repoHideAlls = 0;
  newReposHiddenTurnedOn = 0;
  return taken;
}
