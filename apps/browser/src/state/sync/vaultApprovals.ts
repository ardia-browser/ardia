import { SyncNative, vaultChallenge, vaultKeyOf, vaultOrigin, vaultRequestsAdapter, visible, VAULT_KEY, VAULT_REQUEST_MAX_MS, type Adapter, type ScopeState, type VaultAnswerRecord, type VaultRequestRecord } from "../../platform/sync";
import { useBrowser } from "../browser/store";
import type { ConsentToken } from "../telemetry/consentPeriod";
import { notePhoneApproval } from "../telemetry/vaultPhoneApprovalCounts";
import { scheduleSync, syncWritesOpen, useSync } from "./engine";

export type VaultApprovalAsk = { id: string; nonce: string; profile: string; program: string; sites: string[]; why?: string; alwaysOffered: boolean; expiresAt: number };
export type VaultApprovalAnswer = { allow: true; always: boolean; nonce: string; phone: string; signature: string };
export type PhoneCheck = "ok" | "unenrolled" | "bad_signature";
export type PhoneKey = { phone: string; name: string; fingerprint: string; trusted: boolean };

export type VaultApprovalChannel = {
  deviceId: () => string | null;
  usable: () => boolean;
  app: () => ScopeState | undefined;
  profileName: (profile: string) => string;
  cycleSoon: () => void;
  verify: (phone: string, message: string, signature: string) => PhoneCheck;
  trusted: () => { phone: string; fingerprint: string }[];
  fingerprint: (key: string) => string | null;
  trust: (phone: string, key: string) => boolean;
  forget: (phone: string) => boolean;
};

type OpenAsk = { request: VaultRequestRecord; askedAt: number; consent: ConsentToken | null | undefined; settle: (answer: VaultApprovalAnswer | null) => void; timer: ReturnType<typeof setTimeout> };

const PHONE_SEEN_MS = 14 * 86_400_000;
const CYCLE_GONE_MS = 60_000;
const ASKING_CYCLE_MS = 2_000;
const MAX_TEXT = 300;
const ID = /^[0-9a-f-]{8,64}$/;
const openAsks = new Map<string, OpenAsk>();
let lastCycle: { me: string; app: () => ScopeState | undefined; at: number } | null = null;
let poll: ReturnType<typeof setInterval> | undefined;

const syncChannel: VaultApprovalChannel = {
  deviceId: () => lastCycle?.me ?? null,
  usable: () => !!lastCycle && Date.now() - lastCycle.at < CYCLE_GONE_MS && syncWritesOpen() && useSync.getState().status !== "offline",
  app: () => lastCycle?.app(),
  profileName: (profile) => useBrowser.getState().profiles[profile]?.name ?? "",
  cycleSoon: () => scheduleSync(0),
  verify: (phone, message, signature) => SyncNative?.vaultVerifyPhone?.(phone, message, signature) ?? "unenrolled",
  trusted: () => SyncNative?.vaultTrustedPhones?.() ?? [],
  fingerprint: (key) => SyncNative?.vaultPhoneFingerprint?.(key) ?? null,
  trust: (phone, key) => SyncNative?.vaultTrustPhone?.(phone, key) ?? false,
  forget: (phone) => SyncNative?.vaultForgetPhone?.(phone) ?? false,
};

let channel: VaultApprovalChannel | null = syncChannel;
let trustedCache: { phone: string; fingerprint: string }[] | null = null;

export function connectVaultApprovals(next: VaultApprovalChannel | null) {
  for (const id of [...openAsks.keys()]) finish(id, null, "unreachable");
  channel = next;
  trustedCache = null;
}

const trustedPhones = () => (trustedCache ??= channel?.trusted() ?? []);

export function phoneKeys(): PhoneKey[] {
  const app = channel?.app();
  if (!app || !channel) return [];
  const trusted = new Map(trustedPhones().map((t) => [t.phone, t.fingerprint]));
  const out: PhoneKey[] = [];
  for (const [key, value] of visible(app, VAULT_KEY)) {
    const record = vaultKeyOf(key, value);
    const fingerprint = record && deviceKind(app, record.by) === "phone" ? channel.fingerprint(record.k) : null;
    if (!record || !fingerprint) continue;
    const name = (visible(app, "dev:").get(`dev:${record.by}`) as { n?: unknown } | undefined)?.n;
    out.push({ phone: record.by, name: typeof name === "string" && name ? name : "iPhone", fingerprint, trusted: trusted.get(record.by) === fingerprint });
  }
  return out.sort((a, z) => a.name.localeCompare(z.name) || (a.phone < z.phone ? -1 : 1));
}

export function trustPhoneKey(phone: string, fingerprint: string, consent: ConsentToken | null): boolean {
  const app = channel?.app();
  const record = app ? vaultKeyOf(`${VAULT_KEY}${phone}`, visible(app, VAULT_KEY).get(`${VAULT_KEY}${phone}`)) : null;
  if (!channel || !record || channel.fingerprint(record.k) !== fingerprint || !channel.trust(phone, record.k)) return false;
  trustedCache = null;
  notePhoneApproval("trusted", consent);
  channel.cycleSoon();
  return true;
}

export function forgetPhoneKey(phone: string): boolean {
  if (!channel?.forget(phone)) return false;
  trustedCache = null;
  channel.cycleSoon();
  return true;
}

function pollWhileAsking() {
  if (openAsks.size && !poll) poll = setInterval(() => channel?.cycleSoon(), ASKING_CYCLE_MS);
  if (!openAsks.size && poll) {
    clearInterval(poll);
    poll = undefined;
  }
}

const deviceKind = (app: ScopeState | undefined, device: string) => (app ? (visible(app, "dev:").get(`dev:${device}`) as { k?: unknown } | undefined)?.k : undefined);

export function phonesInReach(app: ScopeState | undefined, now = Date.now()): string[] {
  if (!app) return [];
  const out: string[] = [];
  for (const [key, value] of visible(app, "dev:")) {
    const id = key.slice(4);
    if ((value as { k?: unknown } | null)?.k === "phone" && now - (app.seen[id] ?? 0) <= PHONE_SEEN_MS) out.push(id);
  }
  return out.sort();
}

export const vaultApprovalsAsking = () => openAsks.size > 0;

export function askPhoneForVaultApproval(ask: VaultApprovalAsk, consent?: ConsentToken | null): Promise<VaultApprovalAnswer | null> {
  const now = Date.now();
  const me = channel?.usable() ? channel.deviceId() : null;
  if (!channel || !me || !phonesInReach(channel.app(), now).length) {
    notePhoneApproval("unreachable", consent);
    return Promise.resolve(null);
  }
  const sites = ask.sites.map(vaultOrigin);
  const valid = ID.test(ask.id) && typeof ask.nonce === "string" && ask.nonce.length >= 16 && ask.nonce.length <= 128 && typeof ask.profile === "string" && ask.profile.length > 0 && ask.profile.length <= 128;
  if (!valid || !sites.length || sites.length > 32 || sites.some((s) => s === null) || new Set(sites).size !== sites.length || !(ask.expiresAt > now) || openAsks.has(ask.id)) {
    notePhoneApproval("refused", consent);
    return Promise.resolve(null);
  }
  const expiresAt = Math.min(Math.floor(ask.expiresAt), now + VAULT_REQUEST_MAX_MS);
  const request: VaultRequestRecord = {
    id: ask.id,
    n: ask.nonce,
    p: ask.profile,
    pn: channel.profileName(ask.profile).slice(0, MAX_TEXT),
    g: String(ask.program ?? "").slice(0, MAX_TEXT),
    s: sites as string[],
    w: String(ask.why ?? "").slice(0, MAX_TEXT),
    x: expiresAt,
    m: me,
    ao: ask.alwaysOffered === true,
    at: now,
  };
  return new Promise((settle) => {
    const timer = setTimeout(() => finish(request.id, null, "expired"), expiresAt - now);
    openAsks.set(request.id, { request, askedAt: now, consent, settle, timer });
    notePhoneApproval("asked", consent);
    pollWhileAsking();
    channel!.cycleSoon();
  });
}

export function cancelPhoneVaultApproval(id: string) {
  finish(id, null, "cancelled");
}

function finish(id: string, answer: VaultApprovalAnswer | null, outcome: "allowed" | "denied" | "expired" | "cancelled" | "unreachable") {
  const entry = openAsks.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  openAsks.delete(id);
  pollWhileAsking();
  notePhoneApproval(outcome, entry.consent, answer ? Date.now() - entry.askedAt : undefined);
  entry.settle(answer);
  channel?.cycleSoon();
}

export function vaultApprovalsAdapter(me: string, app: () => ScopeState | undefined): Adapter {
  lastCycle = { me, app, at: Date.now() };
  return vaultRequestsAdapter({
    me,
    live: () => [...openAsks.values()].map((w) => w.request),
    isPhone: (device) => deviceKind(app(), device) === "phone",
    author: (key) => app()?.records[key]?.o?.[0],
    trusts: () => trustedPhones().map((t) => ({ phone: t.phone, f: t.fingerprint })),
    answered: (request, answer) => settleFromPhone(request, answer),
  });
}

function settleFromPhone(request: VaultRequestRecord, answer: VaultAnswerRecord) {
  const entry = openAsks.get(request.id);
  if (!entry || !channel) return;
  if (!answer.a) return finish(request.id, null, "denied");
  const check = channel.verify(answer.by, vaultChallenge(request, answer.by, answer.a, answer.al), answer.sig);
  if (check !== "ok") return notePhoneApproval(check, entry.consent);
  finish(request.id, { allow: true, always: answer.al && request.ao, nonce: answer.n, phone: answer.by, signature: answer.sig }, "allowed");
}
