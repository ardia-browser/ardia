const counts = { opened: 0, stepped: 0 };

type FindUse = keyof typeof counts;

export const noteFind = (use: FindUse) => void (counts[use] += 1);

export function takeFindCounts() {
  const taken = { find_opens: counts.opened, find_steps: counts.stepped };
  counts.opened = 0;
  counts.stepped = 0;
  return taken;
}
