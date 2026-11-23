import { CREDENTIAL_DEADLINES_MS, CREDENTIAL_LIMITS, CREDENTIALS_PROTOCOL, CREDENTIALS_PROTOCOLS_SUPPORTED } from "./credentialConstants";
import { isRecord, utf8Length } from "./credentialData";
import { isSecretHandle } from "./credentialErrors";
import { runVerb, secretLookup, type Answer } from "./credentialFakeVerbs";
import { endCallHandles, mintHandle, stopVerbs, type HostState, type OpenCall } from "./credentialHarnessState";
import { readCredentialContribution } from "./credentialManifest";
import { createCredentialRuntime, type CredentialRuntime } from "./credentialRuntime";
import type { CredentialHandlerName, CredentialHarness, CredentialProvider, FakeCli, HarnessAnswer, HarnessContext, HarnessInputs, SignInRunState, VerbParam, WireCredentialError } from "./credentialTypes";
import { CREDENTIAL_METHODS } from "./credentialMethods";
import type { Transport } from "./rpc";
import { buildVerb } from "./verbLaunch";

export type HarnessOptions = { provider: CredentialProvider; manifest: unknown; cli: FakeCli; context?: HarnessContext; helloCredentials?: number | readonly number[]; cliVersion?: string; timers?: HarnessTimers };

export type HarnessTimers = { now(): number; tick(ms: number): void };

export type HarnessExtras = {
  readonly epoch: number;
  readonly runs: number;
  readonly signInRun: SignInRunState;
  readonly handlers: readonly string[];
  readonly confirmations: readonly string[];
  readonly running: number;
  readonly problems: readonly unknown[];
  readonly lines: readonly Readonly<Record<string, unknown>>[];
  cancel(): Promise<void>;
};

const KEY = /^[A-Za-z0-9_-]{1,40}$/;
const ONLY_CREDENTIALS = "A password manager plugin can only use hello, ready, result and credentials requests.";
const realSetTimeout = (globalThis as unknown as { setTimeout(callback: () => void, ms: number): unknown }).setTimeout;
const flush = () => new Promise<void>((resolve) => realSetTimeout(resolve, 0));
const ADVANCE_STEP_MS = 1000;

async function settle() {
  for (let i = 0; i < 5; i++) await flush();
}

function hasHandle(value: unknown): boolean {
  if (isSecretHandle(value) || (isRecord(value) && "$secret" in value)) return true;
  if (Array.isArray(value)) return value.some(hasHandle);
  return isRecord(value) && Object.values(value).some(hasHandle);
}

export function createCredentialHarness(options: HarnessOptions): CredentialHarness & HarnessExtras {
  const contribution = readCredentialContribution(options.manifest);
  const context = options.context ?? {};
  const provider = isRecord(options.manifest) && typeof options.manifest.name === "string" ? options.manifest.name : contribution.cli.name;
  const given = options.helloCredentials ?? CREDENTIALS_PROTOCOLS_SUPPORTED;
  const supported: readonly number[] = typeof given === "number" ? [given] : given;
  const pending = new Map<string, string>();
  const problems: unknown[] = [];
  const lines: Record<string, unknown>[] = [];
  let runtime: CredentialRuntime | null = null;
  let listener: (line: string) => void = () => {};
  let ready: Promise<boolean> = Promise.resolve(false);
  let settleReady: (ok: boolean) => void = () => {};
  let handlers: string[] = [];
  let runs = 0;
  let nextCall = 0;

  const state: HostState = {
    contribution,
    provider,
    context,
    cli: options.cli,
    testFolder: context.testInstance ? `/scratch/Password Managers/${provider}` : null,
    epoch: 1,
    clock: options.timers?.now() ?? 1_763_800_000_000,
    session: context.session ?? null,
    storedSession: context.storedSession ?? null,
    scratch: { ...context.scratch },
    preferences: { ...context.preferences },
    signInRun: { state: "none", hints: [] },
    handles: new Map(),
    nextHandle: 0,
    openCalls: new Map(),
    running: new Set(),
    timers: [],
    launches: [],
    refused: [],
    confirmations: [],
    toPlugin(message) {
      const line = JSON.stringify(message);
      const target = listener;
      void Promise.resolve().then(() => target(line));
    },
  };

  const answerFor = (id: unknown): Answer => ({
    reply: (result) => state.toPlugin({ id, result }),
    refuse: (code, message) => state.toPlugin({ id, error: { code, message } }),
  });

  function closeCall(call: OpenCall, answer: HarnessAnswer, keepOutliving: boolean) {
    if (state.openCalls.get(call.id) !== call) return;
    state.openCalls.delete(call.id);
    stopVerbs(state, (verb) => verb.call !== call.id || (keepOutliving && verb.outlives));
    endCallHandles(state, call.id);
    call.answer(answer);
  }

  function checkedResult(call: OpenCall, result: unknown): HarnessAnswer {
    if (utf8Length(JSON.stringify(result) ?? "null") > CREDENTIAL_LIMITS.resultBytes) return { ok: false, error: { code: "tooLarge" } };
    const signs = (call.name === "signIn" || call.name === "unlock") && isRecord(result) && result.ok === true;
    const { session: given, ...rest } = signs && isRecord(result) ? result : { session: undefined };
    if (hasHandle(signs ? rest : result)) return { ok: false, error: { code: "invalid" } };
    if (!signs) return { ok: true, result };
    const held = isSecretHandle(given) ? state.handles.get(given.$secret) : undefined;
    if (given !== undefined && (!held || held.kind !== "stored" || held.call !== call.id)) return { ok: false, error: { code: "invalid" } };
    if (call.epoch === state.epoch) {
      if (held) state.session = { key: held.value };
      else if (!call.sessionSet) state.session = state.session ?? { key: null };
    }
    return { ok: true, result: rest };
  }

  function onResult(id: unknown, params: Record<string, unknown>) {
    const call = typeof params.call === "string" ? state.openCalls.get(params.call) : undefined;
    if (!call) return answerFor(id).refuse("bad_request", `There's no call ${String(params.call)} waiting.`);
    answerFor(id).reply({ ok: true });
    const answer: HarnessAnswer = "error" in params ? { ok: false, error: params.error as WireCredentialError } : checkedResult(call, params.result);
    if (answer.ok && call.name === "signOut") {
      state.epoch++;
      state.session = null;
      state.storedSession = null;
      state.scratch = {};
      state.preferences = {};
    }
    closeCall(call, answer, true);
  }

  function setValue(params: Record<string, unknown>, answer: Answer) {
    const store = params.store === "scratch" ? state.scratch : params.store === "preferences" ? state.preferences : null;
    const { key, value } = params;
    if (!store || typeof key !== "string" || !KEY.test(key)) return answer.refuse("bad_request", "key must be 1 to 40 letters, digits, - and _.");
    if (value !== null && (typeof value !== "string" || utf8Length(value) > CREDENTIAL_LIMITS.valueBytes)) return answer.refuse("bad_request", `value must be text of at most ${CREDENTIAL_LIMITS.valueBytes} bytes.`);
    if (value !== null && !Object.hasOwn(store, key) && Object.keys(store).length >= CREDENTIAL_LIMITS.valueKeys) return answer.refuse("bad_request", `a store holds at most ${CREDENTIAL_LIMITS.valueKeys} keys.`);
    if (value === null) delete store[key];
    else store[key] = value;
    answer.reply({ ok: true });
  }

  function onRequest(id: unknown, method: string, params: Record<string, unknown>) {
    const answer = answerFor(id);
    const call = typeof params.call === "string" ? state.openCalls.get(params.call) : undefined;
    if (!call) return answer.refuse("closed", `The call ${String(params.call)} has ended.`);
    if (call.epoch !== state.epoch) return answer.refuse("stale", `${contribution.title} locked, so this call ended.`);
    switch (method) {
      case CREDENTIAL_METHODS.verb:
        return void runVerb(state, call, id as number, params, answer);
      case CREDENTIAL_METHODS.verbCancel:
        for (const verb of [...state.running]) if (verb.verbOf === params.verbOf && verb.call === call.id) verb.finish(true);
        return answer.reply({ ok: true });
      case CREDENTIAL_METHODS.signInCancel:
        for (const verb of [...state.running]) if (verb.signIn) verb.finish(true);
        return answer.reply({ ok: true });
      case CREDENTIAL_METHODS.takeStored: {
        if (typeof params.reason !== "string" || params.reason.length > CREDENTIAL_LIMITS.ownerReasonLength) return answer.refuse("bad_request", `reason must be at most ${CREDENTIAL_LIMITS.ownerReasonLength} characters.`);
        state.confirmations.push(params.reason);
        const handle = state.storedSession !== null && context.touchID ? mintHandle(state, state.storedSession, "stored", call.id) : null;
        return answer.reply({ handle });
      }
      case CREDENTIAL_METHODS.dropStored:
        state.storedSession = null;
        return answer.reply({ ok: true });
      case CREDENTIAL_METHODS.valuesSet:
        return setValue(params, answer);
      case CREDENTIAL_METHODS.ownerConfirm:
        state.confirmations.push(typeof params.reason === "string" ? params.reason : "");
        return answer.reply({ confirmed: context.ownerConfirms !== false });
    }
    answer.refuse("refused", ONLY_CREDENTIALS);
  }

  function onPluginLine(line: string) {
    const message = JSON.parse(line) as Record<string, unknown>;
    lines.push(message);
    const params = isRecord(message.params) ? message.params : {};
    const answer = answerFor(message.id);
    if (message.method === "hello") {
      const spoken = typeof params.credentials === "number" ? params.credentials : 0;
      if (!supported.includes(spoken)) {
        answer.refuse("refused", `This ${contribution.title} plugin speaks credentials protocol ${spoken}, and this Ardia speaks ${CREDENTIALS_PROTOCOL}. Update Ardia.`);
        return settleReady(false);
      }
      return answer.reply({ app: "Ardia", version: "1.41.0", protocol: 2, plugin: provider, values: {}, credentials: { protocol: CREDENTIALS_PROTOCOL, supported: [...supported], provider } });
    }
    if (message.method === "ready") {
      const given = isRecord(params.credentialProvider) ? params.credentialProvider.handlers : undefined;
      handlers = Array.isArray(given) ? given.filter((h): h is string => typeof h === "string") : [];
      answer.reply({ ok: true });
      return settleReady(true);
    }
    if (message.method === "result") return onResult(message.id, params);
    if (typeof message.method === "string" && message.method.startsWith("credentials.")) return onRequest(message.id, message.method, params);
    answer.refuse("refused", ONLY_CREDENTIALS);
  }

  function startRun() {
    runtime?.dispose();
    runs++;
    ready = new Promise<boolean>((resolve) => (settleReady = resolve));
    const transport: Transport = { send: (line) => onPluginLine(line), onLine: (registered) => (listener = registered) };
    runtime = createCredentialRuntime(transport, { now: () => state.clock, onError: (error) => problems.push(error) });
    void runtime.define(options.provider);
  }

  function bindTyped(value: unknown, callId: string): unknown {
    if (isSecretHandle(value)) {
      const typed = pending.get(value.$secret);
      if (typed !== undefined) {
        pending.delete(value.$secret);
        state.handles.set(value.$secret, { value: typed, kind: "typed", call: callId, epoch: state.epoch, launches: 0, spent: false });
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((entry) => bindTyped(entry, callId));
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, bindTyped(entry, callId)]));
    return value;
  }

  function contextFor(callId: string): Record<string, unknown> {
    const session = state.session === null ? null : { key: state.session.key === null ? null : mintHandle(state, state.session.key, "session", callId) };
    return {
      epoch: `e${state.epoch}`,
      provider,
      touchID: context.touchID === true,
      offline: context.offline === true,
      session,
      hasStored: state.storedSession !== null,
      signInRun: state.signInRun,
      scratch: { ...state.scratch },
      preferences: { ...state.preferences },
      cli: { name: contribution.cli.name, version: options.cliVersion ?? "1.0.0" },
    };
  }

  async function runLockVerb() {
    const onLock = contribution.cli.onLock;
    if (!onLock || (onLock.skipWithTouchID && context.touchID)) return;
    const params: Record<string, VerbParam> = {};
    for (const [slot, source] of Object.entries(onLock.params)) {
      if ("literal" in source) params[slot] = source.literal;
      else if (source.from === "preference" && Object.hasOwn(state.preferences, source.key)) params[slot] = state.preferences[source.key]!;
      else if (source.from === "session" && state.session?.key) params[slot] = mintHandle(state, state.session.key, "session", null);
    }
    const built = buildVerb(contribution.cli, onLock.verb, params, secretLookup(state, null, []), state.testFolder);
    if (!("launch" in built)) return void state.refused.push({ verb: onLock.verb, reason: built.message });
    state.launches.push(built.launch);
    await Promise.resolve()
      .then(() => options.cli(built.launch))
      .catch(() => undefined);
  }

  async function endAll(code: "stale" | "cancelled") {
    for (const call of [...state.openCalls.values()]) {
      if (code === "cancelled") state.toPlugin({ call: call.id, cancel: true });
      closeCall(call, { ok: false, error: { code } }, false);
    }
    stopVerbs(state);
    await flush();
  }

  startRun();

  return {
    async call<N extends CredentialHandlerName>(name: N, input: HarnessInputs[N]): Promise<HarnessAnswer> {
      if (!(await ready)) return { ok: false, error: { code: "stopped" } };
      const id = `v${++nextCall}`;
      const deadline = CREDENTIAL_DEADLINES_MS[name];
      const answered = new Promise<HarnessAnswer>((resolve) => state.openCalls.set(id, { id, name, epoch: state.epoch, answer: resolve, sessionSet: false, deadline: state.clock + deadline }));
      const call = state.openCalls.get(id)!;
      state.timers.push({
        at: call.deadline,
        fire: () => {
          if (state.openCalls.get(id) !== call) return;
          state.toPlugin({ call: id, cancel: true });
          closeCall(call, { ok: false, error: { code: "timedOut" } }, false);
        },
      });
      state.toPlugin({ call: id, kind: "credentials", name, input: bindTyped(input, id), deadline, context: contextFor(id) });
      return answered;
    },
    secret(value: string) {
      const id = `h${++state.nextHandle}`;
      pending.set(id, value);
      return { $secret: id };
    },
    async lock() {
      state.epoch++;
      await endAll("stale");
      await runLockVerb();
      state.session = null;
      state.scratch = {};
      startRun();
      await ready;
    },
    cancel: () => endAll("cancelled"),
    async advance(ms: number) {
      const target = state.clock + ms;
      for (;;) {
        await settle();
        const due = state.timers.filter((timer) => timer.at <= state.clock).sort((a, b) => a.at - b.at)[0];
        if (due) {
          state.timers = state.timers.filter((timer) => timer !== due);
          due.fire();
          continue;
        }
        if (state.clock >= target) break;
        const next = Math.min(target, state.clock + ADVANCE_STEP_MS, ...state.timers.map((timer) => timer.at));
        options.timers?.tick(next - state.clock);
        state.clock = next;
      }
    },
    get lines() {
      return lines;
    },
    get launches() {
      return state.launches;
    },
    get refused() {
      return state.refused;
    },
    get session() {
      return state.session;
    },
    get storedSession() {
      return state.storedSession;
    },
    get scratch() {
      return state.scratch;
    },
    get preferences() {
      return state.preferences;
    },
    get epoch() {
      return state.epoch;
    },
    get runs() {
      return runs;
    },
    get signInRun() {
      return state.signInRun;
    },
    get handlers() {
      return handlers;
    },
    get confirmations() {
      return state.confirmations;
    },
    get running() {
      return state.running.size;
    },
    get problems() {
      return problems;
    },
  };
}
