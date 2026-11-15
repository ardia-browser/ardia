let sidebarPlayerExpands = 0;
let loopRestarts = 0;

export const noteSidebarPlayerExpand = () => void sidebarPlayerExpands++;

export const noteNowPlayingLoopRestart = () => void loopRestarts++;

export function takeMediaCardCounts() {
  const taken = { sidebar_player_expands: sidebarPlayerExpands, now_playing_loop_restarts: loopRestarts };
  sidebarPlayerExpands = 0;
  loopRestarts = 0;
  return taken;
}
