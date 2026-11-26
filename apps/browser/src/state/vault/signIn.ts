import { listPasswords } from "../site/passwords";
import { originOfLogin } from "../site/savedPasswords";
import { currentManagerPlugin } from "../site/passwordManager";
import { currentTab } from "../browser/current";
import { useBrowser } from "../browser/store";
import { withLivePage } from "../tabs/livePage";
import { cancelVaultSignIn, onLoginFormSeen, vaultSignIn } from "../../platform/vault";
import { onAppEvent } from "../../platform/app";
import { secureRandomHex } from "../../platform/secureRandom";
import type { ConsentToken } from "../telemetry/client";
import { nativeConsent } from "../telemetry/nativeConsent";
import { noteVaultCoordination, noteVaultRefusal, type VaultRefusal } from "../telemetry/vaultCounts";
import { judge, runErrors, runRefusal, VaultError, type EventBase, type RunOutcome } from "./engineResult";
import { recordVaultEvent } from "./activity";
import { dropApprovals } from "./approval";
import { programLabel } from "./programs";
import { withDeadline } from "../../lib/deadline";
import { blockers, heldLanes, holdLane, releaseLane, siteKeyFor, warmSiteKeys, type LaneHolder } from "./lanes";
import { dropAllTasks, drivenTabs, driveTab, liveTaskCount, onTaskGone, taskDrivingTab, taskIsLive, undriveTab, type AutoFill, type GoneReason, type SignInAnswer, type SiteMemory, type VaultTask } from "./tasks";

export { VaultError };

const AUTO_RETRY_MS = 30_000;
const AUTO_FAILURES = 3;
const MANUAL_QUIET_MS = 30_000;
const FINAL_REFUSALS: ReadonlySet<VaultRefusal> = new Set(["not_granted", "no_login", "needs_passkey", "needs_human", "password_manager_plugin", "denied", "bad_request", "task_expired", "locked"]);

const REVOKED: Record<GoneReason | "tab", [VaultRefusal, string]> = {
  ended: ["task_expired", "The task ended before the sign-in finished, so Ardia stopped it."],
  expired: ["task_expired", "The task ran out before the sign-in finished, so Ardia stopped it."],
  closed: ["task_expired", "The connection closed before the sign-in finished, so Ardia stopped it."],
  locked: ["locked", "The Mac locked or slept before the sign-in finished, so Ardia stopped it and ended the task."],
  tab: ["denied", "The tab moved to another profile before the sign-in finished, so Ardia stopped it."],
};

export const tabReloads = { reload: (tabId: string, mayAct: () => boolean) => withLivePage(tabId, (page) => page.reload(), mayAct) };

export const vaultClock = { now: () => performance.now() };

type StopReason = GoneReason | "tab" | "deadline" | "preempted";
type Phase = "lookup" | "queue" | "engine";

type Ticket = { id: string; task: VaultTask; origin: string; tabId: string | null; auto: boolean; phase: Phase; deadline: number; run: SignInRun | null; revoked: StopReason | null; error: VaultError | null; stop: Promise<never>; halt: (error: VaultError) => void };

export type SignInRun = LaneHolder & { id: string; task: VaultTask; origin: string; username: string; auto: boolean; waiters: Set<Ticket>; cancelled: boolean; settling: boolean; reloads: Map<string, Promise<boolean>>; outcome: Promise<RunOutcome>; drained: Promise<void>; release: () => void };

const ANSWER_MS = 28_000;
const DRAIN_MS = 30_000;
const RELOAD_MS = 5_000;
const AUTO_MEMORY = 64;

const DEADLINES: Record<Phase, [VaultRefusal, string]> = {
  lookup: ["failed", "Ardia's password store didn't answer in time, so the sign-in didn't start."],
  queue: ["busy", "Another sign-in for this site was still running when the time ran out; try again shortly."],
  engine: ["failed", "The sign-in took too long, so Ardia stopped it."],
};

export const STEP_ASIDE = new VaultError("busy", "An automatic sign-in stepped aside for one the program asked for.");

const tickets = new Map<string, Ticket>();

function openTicket(task: VaultTask, origin: string, tabId: string | null, auto: boolean, startedAt: number): Ticket {
  let halt: (error: VaultError) => void = () => undefined;
  const stop = new Promise<never>((_, reject) => (halt = reject));
  stop.catch(() => undefined);
  const deadline = vaultClock.now() + ANSWER_MS - Math.max(0, Date.now() - startedAt);
  const ticket: Ticket = { id: secureRandomHex(16), task, origin, tabId, auto, phase: "lookup", deadline, run: null, revoked: null, error: null, stop, halt };
  tickets.set(ticket.id, ticket);
  return ticket;
}

function revoke(ticket: Ticket, why: StopReason) {
  if (ticket.revoked) return;
  ticket.revoked = why;
  ticket.error = why === "preempted" ? STEP_ASIDE : why === "deadline" ? new VaultError(...DEADLINES[ticket.phase]) : new VaultError(...REVOKED[why]);
  ticket.halt(ticket.error);
  leaveRun(ticket);
}

function leaveRun(ticket: Ticket) {
  const run = ticket.run;
  ticket.run = null;
  if (!run) return;
  run.waiters.delete(ticket);
  if (!run.waiters.size) cancelRun(run);
}

function stillAllowed(ticket: Ticket): boolean {
  if (ticket.revoked) return false;
  const { task, tabId } = ticket;
  if (!taskIsLive(task)) revoke(ticket, task.expiresAt <= Date.now() ? "expired" : "closed");
  else if (!task.origins.has(ticket.origin)) revoke(ticket, "ended");
  else if (tabId !== null && currentTab(tabId)?.profileId !== task.profileId) revoke(ticket, "tab");
  return !ticket.revoked;
}

function eligible(ticket: Ticket): boolean {
  if (stillAllowed(ticket) && vaultClock.now() >= ticket.deadline) revoke(ticket, "deadline");
  return !ticket.revoked;
}

function checkpoint(ticket: Ticket) {
  if (!eligible(ticket)) throw ticket.error!;
}

async function within<T>(ticket: Ticket, phase: Phase, work: Promise<T>): Promise<T> {
  ticket.phase = phase;
  checkpoint(ticket);
  const timer = setTimeout(() => revoke(ticket, "deadline"), Math.max(0, ticket.deadline - vaultClock.now()));
  try {
    return await Promise.race([work, ticket.stop]);
  } finally {
    clearTimeout(timer);
    checkpoint(ticket);
  }
}

export function pluginRefusal(profileId: string): VaultError | null {
  const plugin = currentManagerPlugin(profileId);
  return plugin ? new VaultError("password_manager_plugin", `This profile's passwords are kept by ${plugin.title}; Ardia's own password store isn't used, and its plugin doesn't sign agents in.`) : null;
}

async function fetchLogins(task: VaultTask) {
  const saved = await listPasswords(task.engineProfile);
  task.logins.clear();
  for (const login of saved) {
    const origin = originOfLogin(login.origin).toLowerCase();
    if (!task.origins.has(origin)) continue;
    const names = task.logins.get(origin) ?? [];
    if (!names.includes(login.username)) task.logins.set(origin, [...names, login.username]);
  }
}

export function cacheLogins(task: VaultTask): Promise<void> {
  task.loginsLoading ??= fetchLogins(task).catch((error: unknown) => {
    task.loginsLoading = null;
    throw error;
  });
  return task.loginsLoading;
}

function pickUsername(task: VaultTask, origin: string, account: string | null): string {
  const names = task.logins.get(origin) ?? [];
  if (account !== null) {
    if (names.includes(account)) return account;
    throw new VaultError("no_login", "There's no saved login with that account for this site.");
  }
  if (names.length === 1) return names[0]!;
  if (!names.length) throw new VaultError("no_login", "There's no saved login for this site in Ardia's password store.");
  throw new VaultError("bad_request", `This site has ${names.length} saved logins; name one with account.`);
}

function remember(set: Set<string>, key: string) {
  set.delete(key);
  set.add(key);
  while (set.size > AUTO_MEMORY) set.delete(set.values().next().value!);
}

type AutoContext = { state: AutoFill; document: string | null };

function pickAutoUsername(task: VaultTask, origin: string, memory: SiteMemory, context: AutoContext, consent: ConsentToken | null): string {
  if (memory.account !== null) return memory.account;
  const names = task.logins.get(origin) ?? [];
  if (names.length <= 1) return pickUsername(task, origin, null);
  const key = context.document ?? "";
  const seen = context.state.skipped.has(key);
  remember(context.state.skipped, key);
  if (seen) throw STEP_ASIDE;
  noteVaultCoordination("skipped_several", consent);
  recordVaultEvent({ time: Date.now(), kind: "skip", profile: task.profileId, site: origin, account: null, program: programLabel(task.program), signer: task.program.signer, task: task.id.slice(0, 8), outcome: "several_logins", via: "auto", reason: task.why });
  throw STEP_ASIDE;
}

function signInUrl(origin: string, tabId: string | null): string {
  const url = tabId ? currentTab(tabId)?.url : undefined;
  return url && originOfLogin(url).toLowerCase() === origin ? url : `${origin}/`;
}

function siteMemory(task: VaultTask, origin: string): SiteMemory {
  if (!task.sites.has(origin)) task.sites.set(origin, { account: null, manualPending: 0, manualEndedAt: 0 });
  return task.sites.get(origin)!;
}

const manualClaims = (memory: SiteMemory | undefined) => !!memory && (memory.manualPending > 0 || Date.now() - memory.manualEndedAt < MANUAL_QUIET_MS);

const MOVED: ReadonlySet<string> = new Set(["complete", "partial", "sent"]);

function settleRun(run: SignInRun, moved: boolean, record: () => RunOutcome): RunOutcome {
  run.settling = true;
  for (const waiter of [...run.waiters]) eligible(waiter);
  if (run.waiters.size || moved) return record();
  return { answer: null, error: new VaultError(...REVOKED.ended), drive: false, reload: false };
}

function startRun(ticket: Ticket, key: string | null, username: string, auto: boolean, base: EventBase, consent: ConsentToken | null): SignInRun {
  const { task, origin } = ticket;
  let drain: () => void = () => undefined;
  const drained = new Promise<void>((resolve) => (drain = resolve));
  const run: SignInRun = { id: secureRandomHex(16), profile: task.engineProfile, key, task, origin, username, auto, waiters: new Set(), cancelled: false, settling: false, reloads: new Map(), outcome: Promise.resolve({ answer: null, error: null, drive: false, reload: false }), drained, release: () => undefined };
  const finish = () => (releaseLane(run), drain());
  run.release = finish;
  holdLane(run);
  run.outcome = vaultSignIn(task.engineProfile, signInUrl(origin, ticket.tabId), origin, username, run.id)
    .then(
      (result) => settleRun(run, MOVED.has(result.transfer ?? "none"), () => judge(result, auto, username, base, consent)),
      (error: unknown) => settleRun(run, false, () => runRefusal(new VaultError("failed", error instanceof Error ? error.message : String(error)), username, base, consent)),
    )
    .finally(finish);
  return run;
}

function cancelRun(run: SignInRun) {
  if (run.cancelled || run.settling) return;
  run.cancelled = true;
  void cancelVaultSignIn(run.id).catch(() => false);
  setTimeout(run.release, DRAIN_MS);
}

function joinRun(ticket: Ticket, run: SignInRun) {
  ticket.run = run;
  run.waiters.add(ticket);
}

async function claimRun(ticket: Ticket, username: string, auto: boolean, base: EventBase, consent: ConsentToken | null): Promise<SignInRun> {
  const { task, origin } = ticket;
  for (;;) {
    checkpoint(ticket);
    const key = siteKeyFor(task, origin);
    const ahead = blockers<SignInRun>(task.engineProfile, key);
    const shared = ahead.find((run) => run.task === task && run.origin === origin && run.username === username && !run.cancelled && !run.settling);
    if (shared) {
      joinRun(ticket, shared);
      if (!auto) noteVaultCoordination("joined", consent);
      return shared;
    }
    if (!ahead.length) {
      const run = startRun(ticket, key, username, auto, base, consent);
      joinRun(ticket, run);
      return run;
    }
    if (auto) throw STEP_ASIDE;
    for (const run of ahead) if (run.task === task && run.waiters.size && [...run.waiters].every((waiter) => waiter.auto)) for (const waiter of [...run.waiters]) revoke(waiter, "preempted");
    await within(ticket, "queue", Promise.race(ahead.map((run) => run.drained)));
  }
}

function reloadOnce(run: SignInRun, ticket: Ticket, tabId: string): Promise<boolean> {
  const { task, origin } = ticket;
  const mayAct = () => taskIsLive(task) && task.origins.has(origin) && currentTab(tabId)?.profileId === task.profileId;
  if (!run.reloads.has(tabId)) run.reloads.set(tabId, tabReloads.reload(tabId, mayAct).catch(() => false));
  return run.reloads.get(tabId)!;
}

type Request = { task: VaultTask; origin: string; account: string | null; tabId: string | null; why: string; auto: boolean; startedAt?: number; consent: ConsentToken | null; autoContext?: AutoContext };

export async function signIn({ task, origin, account, tabId, why, auto, startedAt = Date.now(), consent, autoContext }: Request): Promise<SignInAnswer> {
  const ticket = openTicket(task, origin, tabId, auto, startedAt);
  const base: EventBase = { profile: task.profileId, site: origin, program: programLabel(task.program), signer: task.program.signer, task: task.id.slice(0, 8), via: auto ? "auto" : "login", reason: why };
  let username: string | null = account;
  let memory: SiteMemory | null = null;
  try {
    const refused = pluginRefusal(task.profileId);
    if (refused) throw refused;
    if (!task.origins.has(origin)) throw new VaultError("not_granted", "This task wasn't granted that site.");
    checkpoint(ticket);
    memory = siteMemory(task, origin);
    if (!auto) memory.manualPending++;
    await within(ticket, "lookup", Promise.all([cacheLogins(task), warmSiteKeys([origin]).catch(() => undefined)]));
    if (auto && manualClaims(memory)) throw STEP_ASIDE;
    username = auto && autoContext ? pickAutoUsername(task, origin, memory, autoContext, consent) : pickUsername(task, origin, account);
    if (!auto) memory.account = username;
    const run = await claimRun(ticket, username, auto, base, consent);
    const outcome = await within(ticket, "engine", run.outcome);
    ticket.run = null;
    run.waiters.delete(ticket);
    if (outcome.drive && tabId) driveTab(task, tabId);
    const reloaded = outcome.reload && tabId ? await withDeadline(reloadOnce(run, ticket, tabId), RELOAD_MS, false) : null;
    if (outcome.error) throw outcome.error;
    return { ...outcome.answer!, reloaded, appMs: Date.now() - startedAt };
  } catch (error) {
    if (error === STEP_ASIDE) throw error;
    const refusal = error instanceof VaultError ? error : new VaultError("failed", error instanceof Error ? error.message : String(error));
    if (!runErrors.has(refusal)) {
      noteVaultRefusal(refusal.code, consent);
      recordVaultEvent({ ...base, time: Date.now(), kind: "refusal", account: username, outcome: refusal.code });
    }
    throw refusal;
  } finally {
    tickets.delete(ticket.id);
    leaveRun(ticket);
    if (memory && !auto) {
      memory.manualPending--;
      memory.manualEndedAt = Date.now();
    }
  }
}

function autoFill(task: VaultTask, tab: string, origin: string): AutoFill {
  const key = `${tab}\n${origin}`;
  if (!task.auto.has(key)) task.auto.set(key, { documents: new Set(), skipped: new Set(), lastSuccess: 0, failures: 0, stopped: false });
  return task.auto.get(key)!;
}

function revokeTab(tab: string) {
  for (const ticket of [...tickets.values()]) if (ticket.tabId === tab) revoke(ticket, "tab");
}

let guarding = false;

function guard() {
  if (guarding) return;
  guarding = true;
  onTaskGone((task, why) => {
    for (const ticket of [...tickets.values()]) if (ticket.task === task) revoke(ticket, why);
  });
  onAppEvent((e) => {
    if (e.type !== "lockedOrAsleep" && e.type !== "screenLocked") return;
    dropApprovals(undefined, "locked");
    dropAllTasks("locked");
  });
  useBrowser.subscribeTo(["tabs"], (s, prev) => {
    if (s.tabs === prev.tabs || (!liveTaskCount() && !tickets.size)) return;
    for (const [task, tab] of drivenTabs()) {
      if (s.tabs[tab]?.profileId === task.profileId) continue;
      undriveTab(task, tab);
      revokeTab(tab);
    }
    for (const ticket of [...tickets.values()]) if (ticket.tabId && s.tabs[ticket.tabId]?.profileId !== ticket.task.profileId) revoke(ticket, "tab");
  });
}

let watching: { remove(): void } | null = null;

export function watchVault() {
  guard();
  watching ??= onLoginFormSeen((form) => {
    if ((!form.hasPassword && !form.hasOneTimeCode) || form.mainFrame === false) return;
    const origin = form.origin.toLowerCase();
    const task = taskDrivingTab(form.tab, origin);
    if (!task || task.busyTabs.has(form.tab)) return;
    const state = autoFill(task, form.tab, origin);
    const document = form.document === undefined ? null : String(form.document);
    if (state.stopped) return;
    if (document !== null && state.documents.has(document)) return void remember(state.documents, document);
    if (Date.now() - state.lastSuccess < AUTO_RETRY_MS) return;
    const consent = nativeConsent(form);
    if (manualClaims(task.sites.get(origin))) return void noteVaultCoordination("held_for_login", consent);
    if (blockers(task.engineProfile, siteKeyFor(task, origin)).length) return;
    task.busyTabs.add(form.tab);
    void signIn({ task, origin, account: null, tabId: form.tab, why: task.why, auto: true, consent, autoContext: { state, document } })
      .then(
        () => {
          state.failures = 0;
          state.lastSuccess = Date.now();
          if (document !== null) remember(state.documents, document);
        },
        (error: unknown) => {
          if (error === STEP_ASIDE) return;
          const code = error instanceof VaultError ? error.code : "failed";
          if (FINAL_REFUSALS.has(code) || ++state.failures >= AUTO_FAILURES) state.stopped = true;
        },
      )
      .finally(() => task.busyTabs.delete(form.tab));
  });
}

export const liveAttempts = () => tickets.size;

export const runningSignIns = (task: VaultTask) => heldLanes(task.engineProfile);
