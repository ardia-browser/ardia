export type CodeCell = { kind: "digit"; at: number; char: string } | { kind: "space" };

export type ShownCode = { owner: string; code: string; expiresAt: number; period: number };

export type CodeRoll = { changed: readonly boolean[]; turn: number };

export const PLACEHOLDER_CODE = "••••••";

const groupSize = (length: number) => (length === 6 || length === 8 ? length / 2 : 0);

export function codeCells(code: string): CodeCell[] {
  const group = groupSize(code.length);
  const cells: CodeCell[] = [];
  for (let at = 0; at < code.length; at += 1) {
    if (group && at === group) cells.push({ kind: "space" });
    cells.push({ kind: "digit", at, char: code.charAt(at) });
  }
  return cells;
}

export const spokenCode = (code: string) => `Code ${code.split("").join(" ")}`;

export function rolledDigits(shown: ShownCode | null, next: ShownCode | null): boolean[] | null {
  if (!shown || !next || shown.owner !== next.owner || shown.code === next.code) return null;
  if (shown.code.length !== next.code.length || shown.period !== next.period) return null;
  const periodMs = next.period * 1000;
  if (periodMs <= 0 || Math.round((next.expiresAt - shown.expiresAt) / periodMs) !== 1) return null;
  return [...next.code].map((char, at) => char !== shown.code[at]);
}

export const sameShown = (a: ShownCode | null, b: ShownCode | null) => a === b || (!!a && !!b && a.owner === b.owner && a.code === b.code && a.expiresAt === b.expiresAt);

export type RollState = { shown: ShownCode | null; roll: CodeRoll | null; turn: number };

export const restingRoll = (shown: ShownCode | null): RollState => ({ shown, roll: null, turn: 0 });

export function advanceRoll(state: RollState, next: ShownCode | null): RollState {
  const { shown } = state;
  if (sameShown(shown, next)) return state;
  if (shown && next && shown.owner === next.owner && shown.code === next.code) return { ...state, shown: next };
  const changed = rolledDigits(shown, next);
  if (!changed || !shown) return { shown: next, roll: null, turn: state.turn };
  const turn = state.turn + 1;
  return { shown: next, roll: { changed, turn }, turn };
}
