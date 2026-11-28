import type { RemoteOutcome } from "./omnibox.ts";

export type RemoteAnswer = { text: string; values: string[] };

export type RemoteFetch = (text: string, signal: AbortSignal) => Promise<RemoteOutcome>;

export type RemoteAsk = { scope: string; text: string; remembers: boolean; current: () => string | null; show: (answer: RemoteAnswer, cached: boolean) => void };

export type RemoteClock = { now: () => number; later: (run: () => void, ms: number) => unknown; cancel: (timer: unknown) => void };

export const MOST_REMOTE_IN_FLIGHT = 3;

export const REMOTE_ANSWERS_KEPT = 64;

export const BLOCKED_BACKOFF_MS = 30_000;

export const BLOCKED_BACKOFF_MAX_MS = 300_000;

export const PACED_DELAY_MS = 150;

export const PACED_FOR_MS = 30_000;

const BLOCKED_STATUSES = new Set([403, 429]);

const systemClock: RemoteClock = {
  now: () => Date.now(),
  later: (run, ms) => setTimeout(run, ms),
  cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export const suggestQueryOf = (text: string) => text.trim().replace(/^\?/, "").trim().toLowerCase();

export function carriedValues(answer: RemoteAnswer | null, text: string): string[] {
  if (!answer?.text || !text.startsWith(answer.text)) return [];
  if (answer.text === text) return answer.values;
  const typed = suggestQueryOf(text);
  return answer.values.filter((value) => value.toLowerCase().startsWith(typed));
}

type Flight = { scope: string; text: string; controller: AbortController };

export function createRemoteSuggester(fetchRemote: RemoteFetch, clock: RemoteClock = systemClock) {
  const answers = new Map<string, string[]>();
  let flights: Flight[] = [];
  let asked = 0;
  let shownTicket = 0;
  let shown: { scope: string; answer: RemoteAnswer } | null = null;
  let blockedUntil = 0;
  let refusals = 0;
  let pacedUntil = 0;
  let paced: unknown = null;

  const answerKey = (scope: string, text: string) => `${scope}\u0000${text}`;

  const remember = (key: string, values: string[]) => {
    answers.delete(key);
    answers.set(key, values);
    if (answers.size > REMOTE_ANSWERS_KEPT) answers.delete(answers.keys().next().value!);
  };

  const land = (ticket: number, ask: RemoteAsk, values: string[], cached: boolean) => {
    const now = ask.current();
    if (now === null || !now.startsWith(ask.text) || ticket < shownTicket) return;
    shownTicket = ticket;
    shown = { scope: ask.scope, answer: { text: ask.text, values } };
    ask.show(shown.answer, cached);
  };

  const ground = (keep: (flight: Flight) => boolean) => {
    const grounded = flights.filter((flight) => !keep(flight));
    flights = flights.filter(keep);
    for (const flight of grounded) flight.controller.abort();
  };

  const prune = (scope: string, text: string) => {
    if (paced !== null) clock.cancel(paced);
    paced = null;
    ground((flight) => flight.scope === scope && text !== "" && text.startsWith(flight.text));
  };

  const noteOutcome = (outcome: RemoteOutcome) => {
    if (outcome.status === "ok") {
      refusals = 0;
      return;
    }
    if (outcome.status !== "http") return;
    const now = clock.now();
    if (outcome.code !== undefined && BLOCKED_STATUSES.has(outcome.code)) {
      refusals += 1;
      const base = BLOCKED_BACKOFF_MS * 2 ** Math.min(refusals - 1, 4);
      blockedUntil = now + Math.min(BLOCKED_BACKOFF_MAX_MS, Math.max(outcome.retryAfterMs ?? 0, base));
      return;
    }
    pacedUntil = now + PACED_FOR_MS;
  };

  const send = (ticket: number, ask: RemoteAsk, key: string) => {
    const flight: Flight = { scope: ask.scope, text: ask.text, controller: new AbortController() };
    flights.push(flight);
    if (flights.length > MOST_REMOTE_IN_FLIGHT) ground((other) => flights.indexOf(other) >= flights.length - MOST_REMOTE_IN_FLIGHT);
    void fetchRemote(ask.text, flight.controller.signal).then((outcome) => {
      flights = flights.filter((other) => other !== flight);
      if (flight.controller.signal.aborted) return;
      noteOutcome(outcome);
      if (outcome.status !== "ok") return;
      if (ask.remembers) remember(key, outcome.values);
      land(ticket, ask, outcome.values, false);
    });
  };

  return {
    shown(scope: string): RemoteAnswer | null {
      return shown?.scope === scope ? shown.answer : null;
    },
    forget(drop: (value: string) => boolean) {
      if (shown) shown = { scope: shown.scope, answer: { text: shown.answer.text, values: shown.answer.values.filter((value) => !drop(value)) } };
      for (const [key, values] of answers) answers.set(key, values.filter((value) => !drop(value)));
    },
    reset() {
      shown = null;
      shownTicket = ++asked;
      prune("", "");
    },
    prune,
    inFlight: () => flights.length,
    ask(ask: RemoteAsk) {
      const ticket = ++asked;
      prune(ask.scope, ask.text);
      const key = answerKey(ask.scope, ask.text);
      const known = answers.get(key);
      if (known) {
        land(ticket, ask, known, true);
        return;
      }
      const now = clock.now();
      if (now < blockedUntil) return;
      if (now < pacedUntil) {
        paced = clock.later(() => {
          paced = null;
          if (ask.current() === ask.text) send(ticket, ask, key);
        }, PACED_DELAY_MS);
        return;
      }
      send(ticket, ask, key);
    },
  };
}
