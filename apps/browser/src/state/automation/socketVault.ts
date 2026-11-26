import { controlPeer } from "../../platform/automation";
import { isTestInstance } from "../../platform/launchConfig";
import { secureRandomHex } from "../../platform/secureRandom";
import { screenLocked, warmVault } from "../../platform/vault";
import { engineProfile } from "../browser/model";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { noteVaultAlwaysAdded, noteVaultGrant, noteVaultRefusal, noteVaultTiming, type VaultRefusal } from "../telemetry/vaultCounts";
import { clippedReason, recordVaultEvent, vaultLog } from "../vault/activity";
import { alwaysAllowed, loadVaultAlways, setAlwaysAllowed, useVaultAlways } from "../vault/always";
import { askApproval, dropApprovals } from "../vault/approval";
import { mayAlwaysAllow, programKey, programLabel, programOf, signerLine, type Program } from "../vault/programs";
import { cacheLogins, pluginRefusal, signIn, VaultError, watchVault } from "../vault/signIn";
import { warmSiteKeys } from "../vault/lanes";
import { addTask, DEFAULT_TTL_SECONDS, dropAllTasks, dropConnectionTasks, dropTask, MAX_SITES, MAX_TTL_SECONDS, siteOrigin, taskFor, tasksOf, type VaultTask } from "../vault/tasks";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { shownWindowId } from "./socketAsk";
import { id, int, obj, PROFILE, text } from "./socketSchema";
import { now, profileArg, tabOf } from "./socketTargets";
import { OpError } from "./workspaceTargets";

const WHY = text("Why the agent signs in, shown to the person in Ardia's approval sheet and activity log");

const peers = new Map<number, Promise<Program>>();

function programFor(connection: number): Promise<Program> {
  if (!peers.has(connection)) peers.set(connection, controlPeer(connection).then((peer) => programOf(peer, null), () => programOf(null, null)));
  return peers.get(connection)!;
}

export function vaultConnectionClosed(connection: number) {
  peers.delete(connection);
  dropApprovals(connection);
  dropConnectionTasks(connection);
}

export function vaultControlStopped() {
  peers.clear();
  dropApprovals();
  dropAllTasks();
}

const programRow = (program: Program) => ({ name: programLabel(program), kind: program.kind, signer: program.signer, teamId: program.teamId, identifier: program.identifier, path: program.path, alwaysAllowed: mayAlwaysAllow(program) });

function refuse(code: VaultRefusal, message: string, event: { profile: string; site: string | null; program: Program; task: string | null; via: string; reason: string }, consent: ConsentToken | null): never {
  noteVaultRefusal(code, consent);
  recordVaultEvent({ time: Date.now(), kind: "refusal", profile: event.profile, site: event.site, account: null, program: programLabel(event.program), signer: event.program.signer, task: event.task, outcome: code, via: event.via, reason: event.reason });
  throw new OpError(code, message);
}

function originsOf(sites: unknown): string[] {
  const allowLocal = isTestInstance();
  const out: string[] = [];
  for (const site of sites as string[]) {
    const origin = siteOrigin(site, allowLocal);
    if (!origin) throw new OpError("bad_request", `${site.slice(0, 80)} isn't an https site.`);
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

async function taskStart(params: Record<string, unknown>, call: SocketCall) {
  const consent = consentToken();
  const profileId = profileArg(params.profile);
  const origins = originsOf(params.sites);
  void warmSiteKeys(origins).catch(() => undefined);
  const why = clippedReason(params.why);
  const ttl = Math.min(MAX_TTL_SECONDS, (params.ttlSeconds as number | undefined) ?? DEFAULT_TTL_SECONDS);
  const tabs = ((params.tabs as string[] | undefined) ?? []).map((tab) => tabOf(tab));
  if (tabs.some((t) => t.profileId !== profileId)) throw new OpError("bad_request", "Every tab must be in the task's profile.");
  watchVault();
  const program = await programFor(call.connection);
  const base = { profile: profileId, site: origins.join(" "), program, task: null, via: "task", reason: why };
  const plugin = pluginRefusal(profileId);
  if (plugin) refuse(plugin.code, plugin.message, base, consent);
  await loadVaultAlways(consent);
  call.stillServing();
  let via: "sheet" | "phone" | "always" = "always";
  let sheetMs: number | null = null;
  if (!origins.every((origin) => alwaysAllowed(profileId, origin, program))) {
    if (await screenLocked().catch(() => false)) refuse("locked", "The Mac's screen is locked, so nobody can approve the sign-in.", base, consent);
    const windowId = shownWindowId();
    if (!windowId) refuse("needs_human", "Ardia has no window where it can ask the person to approve the sign-in.", base, consent);
    const outcome = await askApproval({ windowId, connection: call.connection, profileId, profileName: now().profiles[profileId]?.name ?? "", program, sites: origins, why }, call.serving, consent);
    if (!outcome.allow) refuse(outcome.code, outcome.message, base, consent);
    via = outcome.via;
    sheetMs = outcome.sheetMs;
    noteVaultTiming("sheet", outcome.sheetMs ?? undefined, consent);
    if (outcome.always && (await setAlwaysAllowed(profileId, origins, program, true))) noteVaultAlwaysAdded(consent);
  }
  call.stillServing();
  const startedAt = Date.now();
  const task: VaultTask = {
    id: secureRandomHex(32),
    connection: call.connection,
    serving: call.serving,
    profileId,
    engineProfile: engineProfile(now(), profileId),
    origins: new Set(origins),
    program,
    why,
    startedAt,
    expiresAt: startedAt + ttl * 1000,
    tabs: new Set(),
    logins: new Map(),
    loginsLoading: null,
    auto: new Map(),
    busyTabs: new Set(),
    sites: new Map(),
    siteKeys: new Map(),
  };
  for (const t of tabs) task.tabs.add(t.id);
  addTask(task);
  void cacheLogins(task).catch(() => undefined);
  void warmVault().catch(() => false);
  noteVaultGrant(via, consent);
  recordVaultEvent({ time: startedAt, kind: "grant", profile: profileId, site: origins.join(" "), account: null, program: programLabel(program), signer: program.signer, task: task.id.slice(0, 8), outcome: "granted", via, reason: why });
  return { task: task.id, sites: origins, expiresAt: task.expiresAt, via, sheetMs, program: programRow(program) };
}

function liveTask(params: Record<string, unknown>, call: SocketCall): VaultTask {
  const found = taskFor(params.task as string, call.connection);
  if ("task" in found) return found.task;
  const message = found.problem === "denied" ? "That task was granted to another connection." : "That task ended, ran out or was never granted; start a new one.";
  noteVaultRefusal(found.problem, consentToken());
  throw new OpError(found.problem, message);
}

function taskEnd(params: Record<string, unknown>, call: SocketCall) {
  const task = liveTask(params, call);
  dropTask(task.id, "ended");
  recordVaultEvent({ time: Date.now(), kind: "end", profile: task.profileId, site: [...task.origins].join(" "), account: null, program: programLabel(task.program), signer: task.program.signer, task: task.id.slice(0, 8), outcome: "ended", via: "task", reason: task.why });
  return { ok: true };
}

async function login(params: Record<string, unknown>, call: SocketCall) {
  const startedAt = Date.now();
  const consent = consentToken();
  const task = liveTask(params, call);
  const origin = siteOrigin(params.site as string, isTestInstance());
  if (!origin) throw new OpError("bad_request", "site isn't an https site.");
  const tab = params.tab === undefined ? null : tabOf(params.tab);
  if (tab && tab.profileId !== task.profileId) throw new OpError("bad_request", "That tab is in another profile than the task.");
  const why = params.why === undefined ? task.why : clippedReason(params.why);
  try {
    return await signIn({ task, origin, account: (params.account as string | undefined) ?? null, tabId: tab?.id ?? null, why, auto: false, startedAt, consent });
  } catch (error) {
    if (error instanceof VaultError) throw new OpError(error.code, error.message);
    throw error;
  }
}

async function status(_params: Record<string, unknown>, call: SocketCall) {
  const consent = consentToken();
  const program = await programFor(call.connection);
  await loadVaultAlways(consent);
  const key = programKey(program);
  return {
    program: { ...programRow(program), description: signerLine(program) },
    tasks: tasksOf(call.connection).map((t) => ({ task: t.id, profile: t.profileId, sites: [...t.origins], tabs: [...t.tabs], expiresAt: t.expiresAt })),
    alwaysAllowed: mayAlwaysAllow(program) ? useVaultAlways.getState().grants.filter((g) => `${g.teamId}\n${g.identifier}` === key).map((g) => ({ profile: g.profile, site: g.origin })) : [],
  };
}

const log = (params: Record<string, unknown>) => vaultLog((params.limit as number | undefined) ?? 100, (params.since as number | undefined) ?? null, params.profile === undefined ? null : profileArg(params.profile));

export const VAULT_METHODS: MethodSpec[] = [
  {
    name: "vault.taskStart",
    mutates: true,
    description: "Ask the person to let this program sign in to the given https sites for a while; Ardia shows its own sheet naming the program and asks for Touch ID. Returns a task token that ends with vault.taskEnd, this connection or the timeout",
    params: obj(
      {
        sites: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_SITES, description: "https sites (example.com or https://example.com)" },
        why: WHY,
        ttlSeconds: int("How long the task may last, in seconds (default 900, at most 7200)", 60, MAX_TTL_SECONDS),
        profile: PROFILE,
        tabs: { type: "array", items: { type: "string" }, maxItems: 50, description: "Tabs the task drives: a sign-in form showing in one of them for a granted site is filled at once" },
      },
      ["sites"],
    ),
    result: "{task, sites, expiresAt, via, sheetMs, program}",
    run: taskStart,
  },
  { name: "vault.taskEnd", mutates: true, description: "End a task early", params: obj({ task: id("The token vault.taskStart gave") }, ["task"]), result: "{ok}", run: taskEnd },
  {
    name: "vault.login",
    mutates: true,
    description:
      "Sign in to a granted site with its saved login (and its verification code, if Ardia keeps one) in a page the agent can't reach, move the session into the profile, then reload the tab. status is signed_in only when the engine is sure, and submitted otherwise, which many single-page sites answer: evidence weak means the session moved and the tab is reloaded so the agent can check its page, none that nothing moved; signals says what the engine saw (navigated, httpOnlyCookie, formGone, pathChanged). reason names why the engine wasn't sure (interrupted) or why it stopped. The site must be the saved login's own: for single sign-on, sign in to the identity provider's site, then reload. Never returns the password, the code or any field value. Errors: not_granted, no_login, no_form, needs_passkey, needs_human, password_manager_plugin, task_expired, denied, locked, conflict, busy, failed, bad_request",
    params: obj({ task: id("The token vault.taskStart gave"), site: text("A site the task was granted"), tab: id("A tab to reload once signed in; it joins the tabs the task drives"), account: text("The username, when the site has several saved logins"), why: WHY }, ["task", "site"]),
    result: "{status, transfer, evidence, signals, reason, reloaded, cancelRequested, conflicts, refills, ms, readyMs, fillMs, decideMs, totalMs, profileMs, seedMs, loadMs, scanMs, transferMs, usedCode, appMs}",
    run: login,
  },
  {
    name: "vault.log",
    mutates: false,
    description: "The agent sign-in activity: grants, fills and refusals, oldest first. The agents' reasons are left out unless the person turned them on in Settings › Passwords",
    params: obj({ limit: int("At most this many entries (default 100)", 1, 500), since: { type: "number", description: "Only entries after this time (ms since 1970)" }, profile: PROFILE }),
    result: "[{time, kind, profile, site, account, program, signer, task, outcome, via, ms?}]",
    run: log,
  },
  { name: "vault.status", mutates: false, description: "Which program Ardia sees on this connection, its live tasks and the sites always allowed for it", params: obj({}), result: "{program, tasks, alwaysAllowed}", run: status },
];


export const vaultMethodsJson = () => `${JSON.stringify(VAULT_METHODS.map(({ name, params, result }) => ({ name, params, result })), null, 2)}\n`;
