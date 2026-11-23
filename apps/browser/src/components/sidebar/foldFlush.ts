const filling = new Map<string, Set<() => void>>();

export function fillingFold(windowId: string, flush: () => void): () => void {
  let folds = filling.get(windowId);
  if (!folds) filling.set(windowId, (folds = new Set()));
  folds.add(flush);
  return () => {
    folds.delete(flush);
    if (!folds.size && filling.get(windowId) === folds) filling.delete(windowId);
  };
}

export const foldsFilling = (windowId: string | null) => windowId !== null && (filling.get(windowId)?.size ?? 0) > 0;

const twoFrames = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));

export async function flushFolds(windowId: string): Promise<boolean> {
  while (foldsFilling(windowId)) {
    const round = [...filling.get(windowId)!];
    for (const flush of round) flush();
    await twoFrames();
    const left = filling.get(windowId);
    if (left && round.every((flush) => left.has(flush))) return false;
  }
  return true;
}
