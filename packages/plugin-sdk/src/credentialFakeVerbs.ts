import { CREDENTIAL_LIMITS } from "./credentialConstants";
import { isRecord } from "./credentialData";
import { fakeOutput, redactable, redactText, type FakeOutcome } from "./credentialFakeOutput";
import { waitAfter, type HeldHandle, type HostState, type OpenCall, type RunningFake } from "./credentialHarnessState";
import type { CredentialVerb } from "./credentialManifestTypes";
import type { FakeLaunch, SecretHandle, VerbParams } from "./credentialTypes";
import { buildVerb, effectiveTimeout, type SecretLookup } from "./verbLaunch";

export type Answer = { reply(result: unknown): void; refuse(code: string, message: string): void };

export function secretLookup(state: HostState, callId: string | null, used: HeldHandle[]): SecretLookup {
  return (handle: SecretHandle) => {
    const held = state.handles.get(handle.$secret);
    if (!held || held.spent || held.epoch !== state.epoch || (callId !== null && held.call !== callId)) return null;
    used.push(held);
    return held.value;
  };
}

function launchOf(state: HostState, launch: FakeLaunch): Promise<FakeOutcome & { started: boolean }> {
  return Promise.resolve()
    .then(() => state.cli(launch))
    .then(
      (reply) => ({ reply, launched: true, cancelled: false, started: true }),
      () => ({ reply: {}, launched: false, cancelled: false, started: false }),
    );
}

function applyUnlock(state: HostState, verb: CredentialVerb, epoch: number, lastLine: string | null): boolean {
  if (!verb.unlocks || epoch !== state.epoch) return false;
  if (verb.output.mode === "lastLineSecret") {
    if (!lastLine) return false;
    state.session = { key: lastLine };
    if (typeof verb.unlocks === "object" && verb.unlocks.persistent && state.context.touchID) state.storedSession = lastLine;
    return true;
  }
  state.session = state.session ?? { key: null };
  return true;
}

export async function runVerb(state: HostState, call: OpenCall, verbOf: number, params: Record<string, unknown>, answer: Answer) {
  const verbId = typeof params.verb === "string" ? params.verb : "";
  const verbParams = (isRecord(params.params) ? params.params : {}) as VerbParams;
  const used: HeldHandle[] = [];
  const built = buildVerb(state.contribution.cli, verbId, verbParams, secretLookup(state, call.id, used), state.testFolder);
  if (!("launch" in built)) {
    state.refused.push({ verb: verbId, reason: built.message });
    return answer.refuse(built.code, built.message);
  }
  if (state.running.size >= CREDENTIAL_LIMITS.runningVerbs) return answer.refuse("overloaded", `${state.contribution.title} has ${CREDENTIAL_LIMITS.runningVerbs} commands running.`);
  const timeoutMs = effectiveTimeout(params.timeoutMs, built.launch.timeoutMs);
  const launch = { ...built.launch, timeoutMs };
  const { verb, consumed, jsonStrings } = built;
  state.launches.push(launch);
  for (const handle of used) if (handle.kind === "typed") handle.launches++;
  if (verb.signIn) {
    for (const other of [...state.running]) if (other.signIn) other.finish(true);
    state.signInRun = { state: "running", hints: [] };
  }
  let settle: (outcome: FakeOutcome) => void = () => {};
  const finished = new Promise<FakeOutcome>((resolve) => (settle = resolve));
  let done = false;
  const finish = (outcome: FakeOutcome) => {
    if (done) return;
    done = true;
    settle(outcome);
  };
  const running: RunningFake = { verbOf, call: call.id, verb: verbId, signIn: verb.signIn, outlives: verb.outlivesCall, finish: (cancelled) => finish({ reply: {}, launched: true, cancelled }) };
  state.running.add(running);
  const secrets = redactable(consumed, 3);
  void launchOf(state, launch).then((outcome) => {
    if (done) return;
    for (const line of outcome.reply.lines ?? []) if (state.openCalls.get(call.id) === call) state.toPlugin({ verbOf, line: { stream: line.stream, text: redactText(line.text, secrets) } });
    const after = outcome.reply.finishAfterMs ?? 0;
    if (after > timeoutMs) waitAfter(state, timeoutMs, () => finish({ ...outcome, reply: { ...outcome.reply, timedOut: true } }));
    else if (after > 0) waitAfter(state, after, () => finish(outcome));
    else finish(outcome);
  });
  const outcome = await finished;
  state.running.delete(running);
  const output = fakeOutput(verb, verbOf, outcome, consumed, jsonStrings);
  for (const handle of used) if (handle.kind === "typed" && (output.succeeded || handle.launches >= CREDENTIAL_LIMITS.typedSecretLaunches)) handle.spent = true;
  const unlocked = output.succeeded && applyUnlock(state, verb, call.epoch, output.lastLine);
  if (unlocked) call.sessionSet = true;
  if (verb.signIn) {
    state.signInRun = outcome.cancelled ? { state: "none", hints: [] } : { state: output.succeeded ? "succeeded" : "failed", hints: output.hints, ...(outcome.reply.timedOut ? { timedOut: true } : {}) };
  }
  if (state.openCalls.get(call.id) !== call) return;
  for (const notice of output.notices) state.toPlugin(notice);
  answer.reply({ ...output.body, verb: verbId, unlocked, signInRun: state.signInRun });
}
