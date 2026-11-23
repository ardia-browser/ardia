import type { CredentialCapability, CredentialErrorCode, CredentialHandlerName, DeniedCommand, ProblemCode } from "./credentialTypes";

export const CREDENTIALS_PROTOCOL = 1;
export const CREDENTIALS_PROTOCOLS_SUPPORTED: readonly number[] = [1];
export const CREDENTIALS_SDK_VERSION = "2.1.0";
export const CREDENTIAL_CALL_KIND = "credentials";
export const CREDENTIAL_CALL_ID_PATTERN = "^v[1-9][0-9]{0,15}$";
export const SECRET_HANDLE_PATTERN = "^h[1-9][0-9]{0,15}$";
export const SNAPSHOT_PATTERN = "^[A-Za-z0-9_-]{1,64}$";
export const EPOCH_PATTERN = "^e[0-9]{1,16}$";
export const CREDENTIAL_MEMORY_MB = { default: 1024, least: 256, most: 4096 } as const;

export const CREDENTIAL_LIMITS = {
  resultBytes: 1048576,
  pageBytes: 983040,
  listedItems: 50_000,
  listPages: 1_000,
  pageCursorLength: 256,
  heldSnapshotMs: 60_000,
  itemIdLength: 512,
  itemTitleLength: 1024,
  usernameLength: 1024,
  passwordLength: 4096,
  urlLength: 2048,
  urlsPerItem: 64,
  vaultNameLength: 256,
  passkeysPerItem: 16,
  passkeyNameLength: 256,
  accountLength: 320,
  detailLength: 240,
  choices: 16,
  choiceTitleLength: 60,
  waitingCalls: 8,
  runningVerbs: 4,
  signInVerbs: 1,
  verbParams: 16,
  idSlotLength: 512,
  enumValueLength: 64,
  codeSlotPattern: "^[A-Za-z0-9]{1,64}$",
  emailSlotLength: 320,
  urlSlotLength: 2048,
  stdinBytes: 4194304,
  stdinJsonDepth: 32,
  defaultOutputBytes: 33554432,
  mostOutputBytes: 167772160,
  outputItemBytes: 1048576,
  stderrBytes: 65536,
  chunkBytes: 262144,
  streamLineBytes: 16384,
  streamLinesPerSecond: 200,
  handlesPerCall: 16,
  secretBytes: 4096,
  typedSecretLaunches: 3,
  valueKeys: 16,
  valueBytes: 1024,
  ownerReasonLength: 60,
} as const;

export const CREDENTIAL_DEADLINES_MS = {
  state: 45_000,
  signIn: 180_000,
  unlock: 120_000,
  signOut: 30_000,
  configure: 60_000,
  list: 240_000,
  reveal: 90_000,
  save: 300_000,
  edit: 300_000,
  addTotp: 300_000,
  "passkeys.list": 120_000,
  "passkeys.get": 90_000,
  "passkeys.save": 300_000,
} as const;

export const VERB_TIMEOUTS_MS = { default: 30_000, least: 1_000, most: 900_000, killGrace: 2_000, drainGrace: 2_000 } as const;

export const DENIED_ENV_PATTERNS: readonly string[] = ["DYLD_*", "LD_*", "NODE_*", "*_PROXY", "SSL_*", "NODE_TLS_*", "HOME", "PATH", "TMPDIR", "XDG_*", "OP_CONNECT_*", "BITWARDENCLI_*"];

export const HOST_ENV: readonly string[] = ["HOME", "USER", "LOGNAME", "TMPDIR", "PATH", "LANG", "http_proxy", "https_proxy", "no_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];

export const DENIED_COMMANDS: Readonly<Record<string, readonly DeniedCommand[]>> = {
  op: [
    { argv: ["run"] },
    { argv: ["inject"] },
    { argv: ["plugin"] },
    { argv: ["read"], withFlags: ["--out-file", "-o"] },
    { argv: ["document", "get"], withFlags: ["--out-file", "-o"] },
    { argv: ["service-account"] },
    { argv: ["connect"] },
    { argv: ["events-api"] },
    { argv: ["item", "share"] },
    { argv: ["update"], withFlags: ["--directory"] },
  ],
  bw: [
    { argv: ["serve"] },
    { argv: ["send"] },
    { argv: ["export"] },
    { argv: ["encode"] },
    { argv: ["get", "attachment"] },
    { argv: ["import"] },
    { argv: ["create", "attachment"], withFlags: ["--file"] },
    { argv: ["receive"], withFlags: ["--output"] },
  ],
  "pass-cli": [{ argv: ["run"] }, { argv: ["inject"] }, { argv: ["ssh-agent"] }],
};

export const GLOBAL_FLAGS: Readonly<Record<string, readonly string[]>> = {
  op: ["--account", "--config", "--encoding", "--format", "--iso-timestamps", "--no-color", "--session", "--cache", "--debug"],
  bw: ["--nointeraction", "--raw", "--pretty", "--response", "--cleanexit", "--quiet", "--session"],
  "pass-cli": ["--output", "--quiet", "--verbose"],
};

export const CLAIMED_PROGRAMS: readonly string[] = ["op", "bw", "pass-cli", "node"];

export const CREDENTIAL_HANDLERS: readonly CredentialHandlerName[] = ["state", "signIn", "unlock", "signOut", "configure", "list", "reveal", "save", "edit", "addTotp", "passkeys.list", "passkeys.get", "passkeys.save"];

export const REQUIRED_CREDENTIAL_HANDLERS: readonly CredentialHandlerName[] = ["state", "signIn", "unlock", "signOut", "list", "reveal"];

export const CREDENTIAL_CAPABILITIES: readonly CredentialCapability[] = ["totp", "save", "edit", "addTotp", "passkeys", "selfHosted", "masterPassword", "touchID"];

export const CAPABILITY_HANDLERS: Readonly<Record<CredentialCapability, readonly (readonly CredentialHandlerName[])[]>> = {
  totp: [],
  save: [["save"]],
  edit: [["edit"]],
  addTotp: [["addTotp"], ["edit"]],
  passkeys: [["passkeys.get", "passkeys.save"]],
  selfHosted: [["configure"]],
  masterPassword: [],
  touchID: [],
};

export const PROBLEM_CODES: readonly ProblemCode[] = [
  "wrongPassword",
  "wrongCredentials",
  "wrongCode",
  "badCode",
  "badServer",
  "chooseMethod",
  "codeOrNewDevice",
  "needsApiKey",
  "organizationKey",
  "notAccepted",
  "unlockNext",
  "signOutFirst",
  "signInFirst",
  "lockedSinceLastUnlock",
  "stayedLocked",
  "approvalTimedOut",
  "appUnreachable",
  "setupNeeded",
  "sessionLock",
  "extraPassword",
  "finishInBrowser",
  "didntStart",
  "premiumNeeded",
  "noVault",
  "unknownVault",
  "cantPrepare",
  "savedNotReturned",
  "incomplete",
  "notTaken",
  "unreadable",
  "tooSlow",
  "notLaunched",
  "timedOut",
  "overflowed",
  "offline",
  "unreachable",
  "outdated",
  "cancelled",
  "failed",
];

export const CREDENTIAL_ERROR_CODES: readonly CredentialErrorCode[] = ["locked", "signedOut", "notFound", "unsupported", "failed"];
