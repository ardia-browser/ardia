export type Fader = { set: (value: number) => void; run: (done: () => void) => () => void };

export type Leaving<N> = { node: N; turn: number };

export function createCrossfade<N>(id: string, node: N, fader: Fader, onLeaving: (leaving: Leaving<N> | null) => void) {
  let shown = { id, node };
  let turn = 0;
  let stop: (() => void) | null = null;
  return {
    show(nextId: string, nextNode: N) {
      if (nextId === shown.id) {
        shown = { id: nextId, node: nextNode };
        return;
      }
      const leaving = { node: shown.node, turn: (turn += 1) };
      shown = { id: nextId, node: nextNode };
      stop?.();
      fader.set(0);
      onLeaving(leaving);
      const mine = leaving.turn;
      stop = fader.run(() => {
        if (mine !== turn) return;
        stop = null;
        fader.set(1);
        onLeaving(null);
      });
    },
    dispose() {
      stop?.();
      stop = null;
    },
  };
}
