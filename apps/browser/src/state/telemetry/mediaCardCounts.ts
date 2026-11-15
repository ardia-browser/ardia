let sidebarPlayerExpands = 0;
let sidebarPlayerReopens = 0;
let loopRestarts = 0;

export function sidebarPlayerOpenCounter() {
  let shownOpen = false;
  let closing = false;
  return {
    motionStarted(open: boolean) {
      if (open) {
        sidebarPlayerExpands++;
        if (closing) sidebarPlayerReopens++;
        shownOpen = true;
      }
      closing = !open && shownOpen;
    },
    closeFinished() {
      closing = false;
    },
  };
}

export const noteNowPlayingLoopRestart = () => void loopRestarts++;

export function takeMediaCardCounts() {
  const taken = { sidebar_player_expands: sidebarPlayerExpands, sidebar_player_reopens: sidebarPlayerReopens, now_playing_loop_restarts: loopRestarts };
  sidebarPlayerExpands = 0;
  sidebarPlayerReopens = 0;
  loopRestarts = 0;
  return taken;
}
