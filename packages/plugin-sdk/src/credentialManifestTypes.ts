import type { CredentialCapability } from "./credentialTypes";

export type SlotType = "id" | "enum" | "flag" | "url" | "email" | "code" | "secret" | "json";

export type VerbSlot = { type: SlotType; optional: boolean; pattern?: string; values?: readonly string[]; allowLocalHttp?: boolean };

export type ArgvToken = string | { slot: string } | { flag: string; slot: string } | { flag: string; when: string };

export type EnvEntry =
  | { name: string; literal: string }
  | { name: string; secretSlot: string }
  | { name: string; testFolder: string }
  | { name: string; testLiteral: string };

export type OutputMode = "json" | "lines" | "lastLineSecret" | "stream";

export type VerbOutput = { mode: OutputMode; items?: string };

export type VerbUnlocks = false | true | { persistent: boolean };

export type CredentialVerb = {
  argv: readonly ArgvToken[];
  slots: Readonly<Record<string, VerbSlot>>;
  env: readonly EnvEntry[];
  stdin: { slot: string; encoding: "utf8" | "base64" } | null;
  timeoutMs: number;
  outputLimitBytes: number;
  output: VerbOutput;
  signIn: boolean;
  unlocks: VerbUnlocks;
  outlivesCall: boolean;
  hints: Readonly<Record<string, readonly string[]>>;
};

export type LockParamSource = { from: "session" } | { from: "preference"; key: string } | { literal: string };

export type CredentialCli = {
  name: string;
  install: { command: string; update?: string; url?: string };
  minimumVersion: string | null;
  patterns: Readonly<Record<string, string>>;
  env: readonly EnvEntry[];
  onLock: { verb: string; params: Readonly<Record<string, LockParamSource>>; skipWithTouchID: boolean } | null;
  verbs: Readonly<Record<string, CredentialVerb>>;
};

export type SignInFieldType = "text" | "email" | "secret";

export type SignInField = { id: string; title: string; type: SignInFieldType; placeholder?: string; hint?: string; optional: boolean; prefill?: "account"; masked: boolean };

export type SignInMethodKind = "fields" | "desktopApproval" | "browserApproval";

export type SignInMethod = { id: string; title: string; kind: SignInMethodKind; fields: readonly SignInField[]; twoStep: boolean; appURL?: string; appTitle?: string };

export type SignInServer = { id: string; title: string; custom?: { title: string; placeholder?: string } };

export type CredentialSignIn = {
  methods: readonly SignInMethod[];
  servers: readonly SignInServer[];
  unlock: { field: string } | null;
  approvalHosts: readonly string[];
};

export type CredentialContribution = {
  title: string;
  symbol: string;
  icon: string | null;
  accent: string | null;
  readsOffline: boolean;
  approvalLastsSeconds: number | null;
  capabilities: readonly CredentialCapability[];
  signIn: CredentialSignIn;
  cli: CredentialCli;
};
