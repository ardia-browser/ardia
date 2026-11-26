import { create } from "zustand";
import { authenticateDeviceOwner, cancelDeviceOwnerCheck } from "../../platform/vault";
import { vaultApprovalAnswer } from "../../platform/launchConfig";
import { secureRandomHex } from "../../platform/secureRandom";
import { backgroundInstance } from "../app/appSettings";
import { orWarn } from "../../lib/fallback";
import { askPhoneForVaultApproval, cancelPhoneVaultApproval } from "../sync/vaultApprovals";
import { mayAlwaysAllow, programLabel, type Program } from "./programs";
import type { ConsentToken } from "../telemetry/consentPeriod";

export type ApprovalAnswer = "allow" | "always" | "deny";
export type ApprovalRequest = {
  id: string;
  windowId: string;
  connection: number;
  profileId: string;
  profileName: string;
  program: Program;
  sites: string[];
  why: string;
  mayAlways: boolean;
  askedAt: number;
  expiresAt: number;
};
export type ApprovalOutcome = { allow: true; always: boolean; via: "sheet" | "phone"; sheetMs: number | null } | { allow: false; code: "denied" | "needs_human" | "locked"; message: string };

export const APPROVAL_SECONDS = 60;
const MAX_WAITING = 4;
const SEAM_FALLBACK_MS = 3000;

type Settled = { allow: true; always: boolean; via: "sheet" | "phone" } | { allow: false; why: "denied" | "cancelled" | "failed" | "gone" | "expired" | "locked" };

type Waiting = { request: ApprovalRequest; nonce: string; resolve: (settled: Settled) => void; shownAt: number | null; timers: ReturnType<typeof setTimeout>[]; checking: boolean; done: boolean };

export const useVaultApproval = create<{ request: ApprovalRequest | null; checking: boolean }>()(() => ({ request: null, checking: false }));

export const phoneApprovals = { ask: askPhoneForVaultApproval, cancel: cancelPhoneVaultApproval };

const waiting: Waiting[] = [];

function showNext() {
  const first = waiting[0] ?? null;
  useVaultApproval.setState({ request: first?.request ?? null, checking: first?.checking ?? false });
}

const entryOf = (id: string) => waiting.find((w) => w.request.id === id && !w.done) ?? null;

function settle(entry: Waiting, settled: Settled) {
  if (entry.done) return;
  entry.done = true;
  waiting.splice(waiting.indexOf(entry), 1);
  for (const timer of entry.timers) clearTimeout(timer);
  if (entry.checking) void cancelDeviceOwnerCheck(entry.request.id).catch(() => false);
  if (!(settled.allow && settled.via === "phone")) phoneApprovals.cancel(entry.request.id);
  showNext();
  entry.resolve(settled);
}

export function markApprovalShown(id: string) {
  const entry = entryOf(id);
  if (!entry || entry.shownAt !== null) return;
  entry.shownAt = Date.now();
  const seam = backgroundInstance ? vaultApprovalAnswer() : null;
  if (seam && seam !== "ignore") setTimeout(() => answerApproval(id, seam), 0);
}

const siteList = (sites: readonly string[]) => sites.map((s) => s.replace(/^https:\/\//, "")).join(", ");

export function answerApproval(id: string, answer: ApprovalAnswer) {
  const entry = entryOf(id);
  if (!entry || entry.checking) return;
  if (answer === "deny") return settle(entry, { allow: false, why: "denied" });
  entry.checking = true;
  showNext();
  void authenticateDeviceOwner(id, `allow ${programLabel(entry.request.program)} to sign in to ${siteList(entry.request.sites)}`)
    .catch(orWarn({ granted: false, how: "failed" as const, ms: 0 }))
    .then((owner) => {
      if (entry.done) return;
      entry.checking = false;
      settle(entry, owner.granted ? { allow: true, always: answer === "always" && entry.request.mayAlways, via: "sheet" } : { allow: false, why: owner.how === "cancelled" ? "cancelled" : "failed" });
    });
}

export function phoneAnswered(id: string, phone: { always: boolean; nonce: string } | null) {
  const entry = entryOf(id);
  if (!entry || !phone || phone.nonce !== entry.nonce) return;
  settle(entry, { allow: true, always: phone.always && entry.request.mayAlways, via: "phone" });
}

export function dropApprovals(connection?: number, why: "gone" | "locked" = "gone") {
  for (const entry of [...waiting]) if (connection === undefined || entry.request.connection === connection) settle(entry, { allow: false, why });
}

const REFUSALS: Record<Exclude<Settled, { allow: true }>["why"], { code: "denied" | "needs_human" | "locked"; message: string }> = {
  denied: { code: "denied", message: "The sign-in was turned down." },
  cancelled: { code: "denied", message: "Touch ID was cancelled, so the sign-in wasn't allowed." },
  failed: { code: "denied", message: "Touch ID or the password didn't confirm the sign-in." },
  gone: { code: "needs_human", message: "The client left before anyone answered." },
  expired: { code: "denied", message: "Nobody approved the sign-in in time." },
  locked: { code: "locked", message: "The Mac locked or slept before anyone answered." },
};

export async function askApproval(input: Omit<ApprovalRequest, "id" | "askedAt" | "expiresAt" | "mayAlways">, serving: () => boolean, consent: ConsentToken | null): Promise<ApprovalOutcome> {
  if (backgroundInstance && !vaultApprovalAnswer()) return { allow: false, code: "needs_human", message: "Ardia runs in the background here, so nobody can see the approval sheet." };
  if (waiting.length >= MAX_WAITING) return { allow: false, code: "needs_human", message: "Other sign-in approvals are already waiting; try again once they're answered." };
  const askedAt = Date.now();
  const request: ApprovalRequest = { ...input, id: secureRandomHex(32), askedAt, expiresAt: askedAt + APPROVAL_SECONDS * 1000, mayAlways: mayAlwaysAllow(input.program) };
  let entry!: Waiting;
  const settled = new Promise<Settled>((resolve) => {
    entry = { request, nonce: secureRandomHex(32), resolve, shownAt: null, timers: [], checking: false, done: false };
    waiting.push(entry);
    showNext();
    entry.timers.push(setTimeout(() => settle(entry, { allow: false, why: "expired" }), request.expiresAt - askedAt));
    if (backgroundInstance) entry.timers.push(setTimeout(() => entry.shownAt === null && markApprovalShown(request.id), SEAM_FALLBACK_MS));
  });
  void phoneApprovals.ask({ id: request.id, nonce: entry.nonce, profile: request.profileId, program: programLabel(request.program), sites: request.sites, why: request.why, alwaysOffered: request.mayAlways, expiresAt: request.expiresAt }, consent)
    .then((phone) => phoneAnswered(request.id, phone))
    .catch(orWarn(undefined));
  const result = await settled;
  const sheetMs = entry.shownAt === null ? null : entry.shownAt - askedAt;
  if (!result.allow) return { allow: false, ...REFUSALS[result.why] };
  if (!serving() || Date.now() > request.expiresAt) return { allow: false, code: "needs_human", message: "The approval came after the client left or the request ran out." };
  return { allow: true, always: result.always, via: result.via, sheetMs };
}
