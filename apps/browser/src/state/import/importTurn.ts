import type { ConsentToken } from "../telemetry/choice";

export type ImportTurn = { token: number; signal: AbortSignal; consent: ConsentToken | null };

type LiveTurn = ImportTurn & { controller: AbortController; reading: boolean; settled: boolean };

let tokens = 0;
let live: LiveTurn | null = null;

export const STALE: unique symbol = Symbol("stale");

export function startTurn(consent: ConsentToken | null, session: AbortSignal): ImportTurn {
  live?.controller.abort();
  const controller = new AbortController();
  if (session.aborted) controller.abort();
  else session.addEventListener("abort", () => controller.abort(), { once: true });
  live = { token: ++tokens, signal: controller.signal, consent, controller, reading: false, settled: false };
  return live;
}

export function endTurn() {
  live?.controller.abort();
  live = null;
}

export const ownsTurn = (turn: ImportTurn) => !turn.signal.aborted && live?.token === turn.token && !live.settled;

export const liveTurn = (): ImportTurn | null => (live && !live.signal.aborted && !live.settled ? live : null);

export async function whileOwned<T, R>(turn: ImportTurn, work: Promise<T>, apply: (value: T) => R, drop?: (value: T) => void): Promise<R | typeof STALE> {
  let value: T;
  try {
    value = await work;
  } catch (error) {
    if (!ownsTurn(turn)) return STALE;
    throw error;
  }
  if (ownsTurn(turn)) return apply(value);
  drop?.(value);
  return STALE;
}

export const isLiveToken = (token: number | null) => token !== null && live?.token === token && !live.signal.aborted && !live.settled;

export function claimRead(turn: ImportTurn): boolean {
  if (!ownsTurn(turn) || live!.reading) return false;
  live!.reading = true;
  return true;
}

export function releaseRead(turn: ImportTurn) {
  if (live?.token === turn.token) live.reading = false;
}

export const readingNow = (turn: ImportTurn) => live?.token === turn.token && live.reading;

export function claimSettle(turn: ImportTurn): boolean {
  if (!ownsTurn(turn)) return false;
  live!.settled = true;
  live!.reading = false;
  return true;
}
