import { CREDENTIAL_CALL_KIND } from "./credentialConstants";
import { CREDENTIAL_METHODS } from "./credentialMethods";
import { isRecord } from "./credentialData";
import { isSecretHandle } from "./credentialErrors";
import type { CredentialContext, CredentialHandlerName, RunningVerb, SignInRunState, StreamLine, ValueStore, VerbOptions, VerbParams, VerbResult } from "./credentialTypes";
import { PluginError } from "./rpc";
import type { CancelSignal } from "./types";

export type VerbHooks = { onItem?: VerbOptions["onItem"]; onLine?: VerbOptions["onLine"] };

export type Sent = { id: number; promise: Promise<unknown>; parts: string[] };

export type Requester = (method: string, params: Record<string, unknown>, hooks?: VerbHooks) => Sent;

export type CallMessage = { call: string; name: CredentialHandlerName; context?: unknown; caller?: unknown; deadline?: unknown };

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

export function signInRunOf(value: unknown): SignInRunState | null {
  if (!isRecord(value)) return null;
  const state = value.state;
  if (state !== "none" && state !== "running" && state !== "succeeded" && state !== "failed") return null;
  const run: SignInRunState = { state, hints: strings(value.hints) };
  if (typeof value.detail === "string") run.detail = value.detail;
  if (typeof value.timedOut === "boolean") run.timedOut = value.timedOut;
  return run;
}

export function verbResultOf(verb: string, reply: unknown, parts: readonly string[]): VerbResult {
  const record = isRecord(reply) ? reply : {};
  const flag = (key: string) => record[key] === true;
  const count = (key: string) => (typeof record[key] === "number" ? (record[key] as number) : 0);
  let parsed: unknown = record.json ?? null;
  if (parts.length) {
    try {
      parsed = JSON.parse(parts.join(""));
    } catch {
      parsed = null;
    }
  }
  return {
    verb,
    status: typeof record.status === "number" ? record.status : -1,
    launched: flag("launched"),
    timedOut: flag("timedOut"),
    cancelled: flag("cancelled"),
    overflowed: flag("overflowed"),
    succeeded: flag("succeeded"),
    stderr: typeof record.stderr === "string" ? record.stderr : "",
    hints: strings(record.hints),
    json: parsed,
    lines: strings(record.lines),
    items: count("items"),
    droppedLines: count("droppedLines"),
    unlocked: flag("unlocked"),
  };
}

function textValues(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (isRecord(value)) for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") out.set(key, entry);
  return out;
}

export function lineOf(value: unknown): StreamLine | null {
  if (!isRecord(value) || typeof value.text !== "string") return null;
  return { stream: value.stream === "stderr" ? "stderr" : "stdout", text: value.text };
}

export function credentialContext(message: CallMessage, signal: CancelSignal, request: Requester, stopped: () => boolean): CredentialContext {
  const callId = message.call;
  const raw = isRecord(message.context) ? message.context : {};
  const rawCli = isRecord(raw.cli) ? raw.cli : {};
  const rawSession = raw.session;
  let signInRun = signInRunOf(raw.signInRun) ?? { state: "none", hints: [] };
  let hasStored = raw.hasStored === true;
  const ended = () => signal.cancelled || stopped();
  const closed = () => new PluginError("closed", `The call ${callId} has ended.`);

  const ask = async (method: string, params: Record<string, unknown> = {}) => {
    if (ended()) throw closed();
    return request(method, { call: callId, ...params }).promise;
  };

  const valueStore = (store: "scratch" | "preferences"): ValueStore => {
    const values = textValues(raw[store]);
    return {
      get: (key) => values.get(key),
      async set(key, value) {
        await ask(CREDENTIAL_METHODS.valuesSet, { store, key, value });
        if (value === null) values.delete(key);
        else values.set(key, value);
      },
    };
  };

  const verb = (id: string, params: VerbParams = {}, options: VerbOptions = {}): RunningVerb => {
    if (ended()) {
      const refused = Promise.reject(closed());
      return { id: 0, cancel() {}, then: (onDone, onFail) => refused.then(onDone, onFail) };
    }
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) if (value !== undefined) cleaned[key] = value;
    const body: Record<string, unknown> = { call: callId, verb: id, params: cleaned };
    if (options.timeoutMs !== undefined) body.timeoutMs = options.timeoutMs;
    const sent = request(CREDENTIAL_METHODS.verb, body, { onItem: options.onItem, onLine: options.onLine });
    const finished = sent.promise.then((reply) => {
      const run = signInRunOf(isRecord(reply) ? reply.signInRun : undefined);
      if (run) signInRun = run;
      return verbResultOf(id, reply, sent.parts);
    });
    return {
      id: sent.id,
      cancel() {
        if (!ended()) void request(CREDENTIAL_METHODS.verbCancel, { call: callId, verbOf: sent.id }).promise.catch(() => undefined);
      },
      then: (onDone, onFail) => finished.then(onDone, onFail),
    };
  };

  return {
    callId,
    kind: CREDENTIAL_CALL_KIND,
    name: message.name,
    context: raw,
    caller: message.caller ?? null,
    deadline: typeof message.deadline === "number" ? message.deadline : undefined,
    signal,
    epoch: typeof raw.epoch === "string" ? raw.epoch : "",
    provider: typeof raw.provider === "string" ? raw.provider : "",
    touchID: raw.touchID === true,
    offline: raw.offline === true,
    cli: {
      name: typeof rawCli.name === "string" ? rawCli.name : "",
      version: typeof rawCli.version === "string" ? rawCli.version : null,
      get signInRun() {
        return signInRun;
      },
      verb,
      async cancelSigningIn() {
        await ask(CREDENTIAL_METHODS.signInCancel);
      },
    },
    session: {
      current: isRecord(rawSession) ? { key: isSecretHandle(rawSession.key) ? rawSession.key : null } : null,
      get hasStored() {
        return hasStored;
      },
      async takeStored(reason) {
        const answer = await ask(CREDENTIAL_METHODS.takeStored, { reason });
        const handle = isRecord(answer) ? answer.handle : null;
        return isSecretHandle(handle) ? handle : null;
      },
      async dropStored() {
        await ask(CREDENTIAL_METHODS.dropStored);
        hasStored = false;
      },
    },
    scratch: valueStore("scratch"),
    preferences: valueStore("preferences"),
    owner: {
      async confirm(reason) {
        const answer = await ask(CREDENTIAL_METHODS.ownerConfirm, { reason });
        return isRecord(answer) && answer.confirmed === true;
      },
    },
  };
}
