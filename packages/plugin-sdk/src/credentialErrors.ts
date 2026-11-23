import { CREDENTIAL_LIMITS } from "./credentialConstants";
import type { CredentialErrorCode, FailureState, ProblemCode, RunHints, SecretHandle, SignInNeed, SignInOutcome, VerbResult, WireCredentialError } from "./credentialTypes";
import { PluginError } from "./rpc";

type ErrorOptions = { problem?: ProblemCode; detail?: string; state?: FailureState; field?: string };

const ESCAPE_CODES = /\x1B\[[0-9;?]*[A-Za-z]/g;
const LOG_PREFIX = /^\[[A-Za-z]+\]\s+\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+/;

export function cleanDetail(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const line = text
    .replace(ESCAPE_CODES, "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return undefined;
  return line.length > CREDENTIAL_LIMITS.detailLength ? line.slice(0, CREDENTIAL_LIMITS.detailLength) : line;
}

function defined<T extends Record<string, unknown>>(record: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) if (value !== undefined) out[key] = value;
  return out as Partial<T>;
}

export class CredentialError extends PluginError {
  declare readonly code: CredentialErrorCode;
  readonly problem: ProblemCode | undefined;
  readonly detail: string | undefined;
  readonly state: FailureState | undefined;
  readonly field: string | undefined;

  private constructor(code: CredentialErrorCode, options: ErrorOptions = {}) {
    const detail = cleanDetail(options.detail);
    super(code, detail ?? options.problem ?? code);
    this.name = "CredentialError";
    this.problem = options.problem;
    this.detail = detail;
    this.state = options.state;
    this.field = options.field;
  }

  static locked(): CredentialError {
    return new CredentialError("locked");
  }

  static signedOut(): CredentialError {
    return new CredentialError("signedOut");
  }

  static notFound(): CredentialError {
    return new CredentialError("notFound");
  }

  static unsupported(): CredentialError {
    return new CredentialError("unsupported");
  }

  static failed(problem: ProblemCode, options: { detail?: string; state?: FailureState; field?: string } = {}): CredentialError {
    return new CredentialError("failed", { ...options, problem });
  }

  static is(error: unknown, code?: CredentialErrorCode): error is CredentialError {
    return error instanceof CredentialError && (code === undefined || error.code === code);
  }

  toWire(): WireCredentialError {
    return defined({ code: this.code, problem: this.problem, detail: this.detail, state: this.state, field: this.field }) as WireCredentialError;
  }
}

export function wireErrorOf(error: unknown): WireCredentialError {
  if (CredentialError.is(error)) return error.toWire();
  const detail = cleanDetail(error instanceof Error ? error.message : typeof error === "string" ? error : undefined);
  return detail ? { code: "failed", problem: "failed", detail } : { code: "failed", problem: "failed" };
}

export const SignIn = {
  done(options: { session?: SecretHandle } = {}): SignInOutcome {
    return options.session ? { ok: true, session: options.session } : { ok: true };
  },
  needs(need: SignInNeed, options: { problem?: ProblemCode; detail?: string; state?: FailureState } = {}): SignInOutcome {
    return { ok: false, need, ...defined({ ...options, detail: cleanDetail(options.detail) }) };
  },
  failed(problem: ProblemCode, options: { detail?: string; state?: FailureState; field?: string } = {}): SignInOutcome {
    return { ok: false, problem, ...defined({ ...options, detail: cleanDetail(options.detail) }) };
  },
  cancelled(state?: FailureState): SignInOutcome {
    return state ? { ok: false, problem: "cancelled", state } : { ok: false, problem: "cancelled" };
  },
};

const SECRET_HANDLE = /^h[1-9][0-9]{0,15}$/;

export function isSecretHandle(value: unknown): value is SecretHandle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const handle = (value as { $secret?: unknown }).$secret;
  return Object.keys(value).length === 1 && typeof handle === "string" && SECRET_HANDLE.test(handle);
}

const UNREACHABLE_HINTS: readonly string[] = [
  "getaddrinfo",
  "enotfound",
  "econnrefused",
  "econnreset",
  "etimedout",
  "ehostunreach",
  "enetunreach",
  "fetch failed",
  "network error",
  "unable to connect",
  "could not resolve host",
  "no such host",
  "certificate",
];

const OUTDATED_HINTS: readonly string[] = ["unknown option", "unknown command", "unrecognized option", "unexpected argument", "please update"];

function mentions(result: Pick<VerbResult, "stderr">, needles: readonly string[]): boolean {
  const haystack = result.stderr.toLowerCase();
  return needles.some((needle) => haystack.includes(needle.toLowerCase()));
}

function problemOf(result: VerbResult, offline: boolean): ProblemCode {
  if (result.cancelled) return "cancelled";
  if (!result.launched) return "notLaunched";
  if (result.timedOut) return "timedOut";
  if (result.overflowed) return "overflowed";
  if (mentions(result, UNREACHABLE_HINTS)) return offline ? "offline" : "unreachable";
  if (mentions(result, OUTDATED_HINTS)) return "outdated";
  return "failed";
}

function firstLineOf(text: string): string | null {
  for (const raw of text.replace(ESCAPE_CODES, "").split(/\r?\n/)) {
    let line = raw.trim().replace(LOG_PREFIX, "");
    if (line.toLowerCase().startsWith("error:")) line = line.slice("error:".length).trim();
    if (line) return line;
  }
  return null;
}

export const verbs = {
  mentions,
  problem: problemOf,
  check(result: VerbResult, hints: RunHints, offline: boolean): void {
    if (result.succeeded) return;
    if (!result.cancelled && !result.timedOut && result.launched) {
      if (hints.locked && mentions(result, hints.locked)) throw CredentialError.locked();
      if (hints.signedOut && mentions(result, hints.signedOut)) throw CredentialError.signedOut();
      if (hints.notFound && mentions(result, hints.notFound)) throw CredentialError.notFound();
    }
    const problem = problemOf(result, offline);
    const detail = problem === "failed" ? firstLineOf(result.stderr) : null;
    throw CredentialError.failed(problem, detail ? { detail } : {});
  },
  firstLine(result: VerbResult): string | null {
    return firstLineOf(result.succeeded ? result.lines.join("\n") : result.stderr);
  },
  unreachableHints: UNREACHABLE_HINTS,
  outdatedHints: OUTDATED_HINTS,
};
