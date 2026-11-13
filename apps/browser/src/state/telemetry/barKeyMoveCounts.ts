const counts = { jk: 0, np: 0 };

export const noteBarCtrlKeyMove = (keys: keyof typeof counts) => void (counts[keys] += 1);

export function takeBarKeyMoveCounts() {
  const taken = { bar_ctrl_jk_moves: counts.jk, bar_ctrl_np_moves: counts.np };
  counts.jk = 0;
  counts.np = 0;
  return taken;
}
