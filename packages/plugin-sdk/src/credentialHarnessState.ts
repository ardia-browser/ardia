import type { CredentialContribution } from "./credentialManifestTypes";
import type { CredentialHandlerName, FakeCli, FakeLaunch, HarnessAnswer, HarnessContext, SignInRunState } from "./credentialTypes";

export type HandleKind = "typed" | "session" | "stored";

export type HeldHandle = { value: string; kind: HandleKind; call: string | null; epoch: number; launches: number; spent: boolean };

export type RunningFake = { verbOf: number; call: string; verb: string; signIn: boolean; outlives: boolean; finish(cancelled: boolean): void };

export type OpenCall = { id: string; name: CredentialHandlerName; epoch: number; answer(answer: HarnessAnswer): void; sessionSet: boolean; deadline: number };

export type Timer = { at: number; fire(): void };

export type HostState = {
  readonly contribution: CredentialContribution;
  readonly provider: string;
  readonly context: HarnessContext;
  readonly cli: FakeCli;
  readonly testFolder: string | null;
  epoch: number;
  clock: number;
  session: { key: string | null } | null;
  storedSession: string | null;
  scratch: Record<string, string>;
  preferences: Record<string, string>;
  signInRun: SignInRunState;
  handles: Map<string, HeldHandle>;
  nextHandle: number;
  openCalls: Map<string, OpenCall>;
  running: Set<RunningFake>;
  timers: Timer[];
  launches: FakeLaunch[];
  refused: { verb: string; reason: string }[];
  confirmations: string[];
  toPlugin(message: Record<string, unknown>): void;
};

export function mintHandle(state: HostState, value: string, kind: HandleKind, call: string | null): { $secret: string } {
  const id = `h${++state.nextHandle}`;
  state.handles.set(id, { value, kind, call, epoch: state.epoch, launches: 0, spent: false });
  return { $secret: id };
}

export function endCallHandles(state: HostState, callId: string) {
  for (const [id, handle] of state.handles) if (handle.call === callId) state.handles.delete(id);
}

export function stopVerbs(state: HostState, keep: (verb: RunningFake) => boolean = () => false) {
  for (const verb of [...state.running]) if (!keep(verb)) verb.finish(true);
}

export const waitAfter = (state: HostState, ms: number, fire: () => void) => state.timers.push({ at: state.clock + ms, fire });
