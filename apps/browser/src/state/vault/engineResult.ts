import type { VaultSignIn } from "../../platform/vault";
import type { ConsentToken } from "../telemetry/client";
import { noteVaultEvidence, noteVaultFailure, noteVaultSignals, noteVaultStopAfterMove, noteVaultFill, noteVaultRefusal, noteVaultTiming, noteVaultTransfer, type VaultRefusal } from "../telemetry/vaultCounts";
import { recordVaultEvent } from "./activity";
import type { SignInAnswer } from "./tasks";

export class VaultError extends Error {
  readonly code: VaultRefusal;

  constructor(code: VaultRefusal, message: string) {
    super(message);
    this.code = code;
  }
}

const STATUS_CODES: Partial<Record<VaultSignIn["status"], VaultRefusal>> = {
  still_on_login: "needs_human",
  needs_human: "needs_human",
  no_form: "no_form",
  no_login: "no_login",
  needs_passkey: "needs_passkey",
  cross_origin: "not_granted",
  cancelled: "task_expired",
  busy: "busy",
  failed: "failed",
};

const STATUS_MESSAGES: Partial<Record<VaultSignIn["status"], string>> = {
  needs_human: "The site wants a step only a person can do (a code sent by text, a CAPTCHA).",
  still_on_login: "Ardia filled the saved login, but the site still shows its sign-in page: it may want a code sent by text, a CAPTCHA or another step only a person can do.",
  no_form: "Ardia didn't find a sign-in form for the saved login on that page.",
  no_login: "Ardia's password store has no saved login for that site and account.",
  needs_passkey: "That site signs in with a passkey, which only the person at the Mac can use.",
  cross_origin: "The sign-in page isn't on the saved login's site. For single sign-on, grant the identity provider's site, sign in there (it needs its own saved login), then reload the tab.",
  cancelled: "The task ended before the sign-in finished.",
  busy: "Another sign-in is running for this site or profile; try again shortly.",
  failed: "The sign-in didn't finish.",
};

const REASON_MESSAGES: Record<NonNullable<VaultSignIn["reason"]>, string> = {
  unreachable: "The sign-in didn't finish: the site couldn't be reached (reason: unreachable).",
  field_missing: "The sign-in didn't finish: a sign-in field Ardia filled was gone when it submitted (reason: field_missing).",
  field_changed: "The sign-in didn't finish: the form changed while Ardia filled it (reason: field_changed).",
  steps: "The sign-in didn't finish: the site wanted more sign-in steps than Ardia follows (reason: steps).",
  no_submit_control: "The sign-in didn't finish: Ardia filled the form but found no button or key that sends it (reason: no_submit_control).",
  interrupted: "The sign-in was interrupted before it finished (reason: interrupted).",
  basic_auth: "The site asks for its password in the browser's own sign-in dialog, which only a person can answer (reason: basic_auth).",
  proxy_auth: "A proxy asks for a password in the browser's own sign-in dialog, which only a person can answer (reason: proxy_auth).",
  get_form: "The sign-in didn't finish: the form would send the password in the page's address, so Ardia didn't submit it (reason: get_form).",
  error_page: "The sign-in didn't finish: the site or the browser showed an error page (reason: error_page).",
};

const SIGNALS = ["navigated", "httpOnlyCookie", "formGone", "pathChanged"] as const;

function signalsOf(result: VaultSignIn): Record<string, boolean> | null {
  const given = result.signals;
  if (!given || typeof given !== "object") return null;
  return Object.fromEntries(SIGNALS.filter((name) => typeof given[name] === "boolean").map((name) => [name, given[name]!]));
}

const TRANSFER_REFUSALS: Partial<Record<NonNullable<VaultSignIn["transfer"]>, [VaultRefusal, string]>> = {
  sent: ["failed", "The sign-in finished and its session was sent to the profile, but Ardia couldn't confirm it arrived, so the tab may not be signed in."],
  partial: ["failed", "The sign-in finished, but Ardia could move only part of the session to the profile, so the tab may not be signed in."],
  timed_out: ["failed", "The sign-in finished, but moving the session to the profile took too long, so the tab may not be signed in."],
};

export type RunOutcome = { answer: SignInAnswer | null; error: VaultError | null; drive: boolean; reload: boolean };

export const runErrors = new WeakSet<VaultError>();

const timing = (value: number | undefined) => (typeof value === "number" && value >= 0 ? value : null);

const REASON_TOKEN = /^[a-z][a-z_]{0,39}$/;

const NEEDS_HUMAN_REASONS: ReadonlySet<string> = new Set(["basic_auth", "proxy_auth"]);

const reasonFits = (status: VaultSignIn["status"], reason: string) => (status === "needs_human" ? NEEDS_HUMAN_REASONS.has(reason) : status === "failed" && !NEEDS_HUMAN_REASONS.has(reason));

function engineMessage(result: VaultSignIn): string {
  const reason = result.reason;
  const known = reason && reasonFits(result.status, reason) ? REASON_MESSAGES[reason] : undefined;
  if (known) return known;
  const base = STATUS_MESSAGES[result.status] ?? "The sign-in didn't finish.";
  return reason && REASON_TOKEN.test(reason) ? `${base} (reason: ${reason})` : base;
}

export type EventBase = { profile: string; site: string; program: string; signer: string | null; task: string; via: string; reason: string };

export function runRefusal(error: VaultError, username: string, base: EventBase, consent: ConsentToken | null, drive = false, reload = false): RunOutcome {
  runErrors.add(error);
  noteVaultRefusal(error.code, consent);
  recordVaultEvent({ ...base, time: Date.now(), kind: "refusal", account: username, outcome: error.code });
  return { answer: null, error, drive, reload };
}

export function judge(result: VaultSignIn, auto: boolean, username: string, base: EventBase, consent: ConsentToken | null): RunOutcome {
  noteVaultTransfer(result.transfer, result, consent);
  for (const [kind, value] of [["profile", result.profileMs], ["seed", result.seedMs], ["load", result.loadMs], ["scan", result.scanMs]] as const) noteVaultTiming(kind, value, consent);
  noteVaultTiming("transfer", result.transferMs, consent);
  if (result.status !== "signed_in") noteVaultFailure(result.reason, consent);
  if (result.status === "submitted") noteVaultEvidence(result.evidence, consent);
  noteVaultSignals(signalsOf(result), consent);
  if (result.cancelRequested === true) noteVaultStopAfterMove(consent);
  const refuse = (error: VaultError, drive = false, reload = false) => runRefusal(error, username, base, consent, drive, reload);
  const code = STATUS_CODES[result.status];
  if (code) return refuse(new VaultError(code, engineMessage(result)));
  const transfer = TRANSFER_REFUSALS[result.transfer ?? "none"];
  const conflicts = result.conflicts ?? 0;
  if (transfer && conflicts > 0) return refuse(new VaultError(transfer[0], `${transfer[1]} You also changed ${conflicts === 1 ? "one of this site's session values" : `${conflicts} of this site's session values`} in Ardia meanwhile, and Ardia kept yours (conflicts: ${conflicts}).`));
  if (transfer) return refuse(new VaultError(...transfer));
  const reload = result.transfer === "complete" && (result.status === "signed_in" || (result.status === "submitted" && result.evidence === "weak"));
  if (result.status === "signed_in" && (result.conflicts ?? 0) > 0) return refuse(new VaultError("conflict", "You changed this site's session in Ardia while the agent was signing in, so Ardia kept your changes and reloaded the tab; it may be signed in as you rather than as the saved login."), true, reload);
  const ms = result.totalMs ?? result.appMs;
  noteVaultFill(auto, result.usedCode, consent);
  noteVaultTiming(auto ? "autofill" : "login", ms, consent);
  noteVaultTiming("ready", result.readyMs, consent);
  noteVaultTiming("fill", result.fillMs, consent);
  noteVaultTiming("decide", result.decideMs, consent);
  recordVaultEvent({ ...base, time: Date.now(), kind: "fill", account: username, outcome: result.status, ms });
  const answer: SignInAnswer = {
    status: result.status,
    transfer: result.transfer ?? "none",
    evidence: result.evidence ?? null,
    signals: signalsOf(result),
    cancelRequested: result.cancelRequested === true,
    reason: result.reason ?? null,
    ms,
    readyMs: timing(result.readyMs),
    fillMs: timing(result.fillMs),
    totalMs: timing(result.totalMs),
    decideMs: timing(result.decideMs),
    profileMs: timing(result.profileMs),
    seedMs: timing(result.seedMs),
    loadMs: timing(result.loadMs),
    scanMs: timing(result.scanMs),
    transferMs: timing(result.transferMs),
    conflicts: result.conflicts ?? 0,
    refills: result.refills ?? 0,
    usedCode: result.usedCode,
  };
  return { answer, error: null, drive: true, reload };
}
