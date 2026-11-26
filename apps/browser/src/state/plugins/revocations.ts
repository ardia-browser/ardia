import { matchRevocations, strongestRevocation, validateRevocationList, type RegistryRevocationsPayload, type RevocationAction, type RevocationMatch } from "@ardia/plugin-sdk/registry";
import { documentSaved, readDocument, syncDocument, writeDocument } from "../../platform/documents";
import { isFields } from "../../lib/decode";
import { defaultRegistry, fetchRevocationList, verifyCachedEnvelope } from "./registryClient";
import type { LockProvenance } from "./lockfile";

const CACHE_DOC = "Plugins/revocations-cache.json";

let list: RegistryRevocationsPayload | null = null;
let seq = -1;
let persistedSeq = -1;
let envelope: unknown = null;
let loaded = false;

function savedEnvelope(): unknown {
  try {
    const doc = JSON.parse(readDocument(CACHE_DOC) ?? "null") as unknown;
    return isFields(doc) ? doc.envelope : null;
  } catch {
    return null;
  }
}

async function loadCache() {
  if (loaded) return;
  loaded = true;
  const cached = savedEnvelope();
  if (cached === null || cached === undefined) return;
  const verified = await verifyCachedEnvelope(defaultRegistry(), cached, (payload) => validateRevocationList(payload));
  if (!verified.ok || verified.value.seq < seq) return;
  list = verified.value;
  seq = verified.value.seq;
  envelope = cached;
  persistedSeq = seq;
}

async function persist(): Promise<boolean> {
  const savedSeq = seq;
  if (persistedSeq >= savedSeq) return true;
  try {
    writeDocument(CACHE_DOC, `${JSON.stringify({ version: 1, seq: savedSeq, envelope })}\n`);
    await documentSaved(CACHE_DOC);
    await syncDocument(CACHE_DOC);
    persistedSeq = Math.max(persistedSeq, savedSeq);
    return true;
  } catch {
    return false;
  }
}

export type RevocationsRefresh = { ok: boolean; changed: boolean; reason?: string };

export const revocationsRequired = () => Object.keys(defaultRegistry().keys).length > 0;

export async function refreshRevocations(): Promise<RevocationsRefresh> {
  await loadCache();
  const got = await fetchRevocationList(defaultRegistry(), Math.max(seq, 0));
  if (!got.ok) return { ok: false, changed: false, reason: got.reason };
  if (got.value.seq < seq) return { ok: false, changed: false, reason: "The registry sent an older revocation list than one already seen" };
  const changed = got.value.seq !== seq || !list;
  list = got.value;
  if (got.value.seq !== seq || envelope === null) envelope = got.envelope;
  seq = got.value.seq;
  if (!(await persist())) return { ok: false, changed, reason: "The revocation list couldn't be saved, so Ardia will try again" };
  return { ok: true, changed };
}

export async function revocationPreflight(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!revocationsRequired()) return { ok: true };
  const got = await refreshRevocations();
  return got.ok ? { ok: true } : { ok: false, reason: `Ardia couldn't check the registry's revocation list, so nothing was installed: ${got.reason ?? "unknown"}` };
}

export const currentRevocations = (): RegistryRevocationsPayload | null => list;

export const revocationSeq = () => seq;

export type RevocationSubject = { id: string; version: string | null } & Partial<Pick<LockProvenance, "sha256" | "source" | "repo">>;

export function revocationsFor(entry: RevocationSubject, repo?: string): RevocationMatch[] {
  if (!entry.version) return [];
  const source = entry.source;
  const named = repo ?? entry.repo ?? (source?.kind === "github" ? source.repo : undefined);
  return matchRevocations(
    {
      id: entry.id,
      version: entry.version,
      ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
      ...(named ? { repo: named } : {}),
      ...(source?.kind === "registry" ? { registry: source.url } : {}),
    },
    list,
  );
}

export const STOPPING_ACTIONS: readonly RevocationAction[] = ["disable", "block"];

export function stoppingRevocation(entry: RevocationSubject, includeYank = false): RevocationMatch | null {
  const matches = revocationsFor(entry);
  const action = strongestRevocation(matches);
  if (!action) return null;
  return STOPPING_ACTIONS.includes(action) || (includeYank && action === "yank") ? matches[0]! : null;
}

export const revocationReason = (match: RevocationMatch) => match.entry?.reason ?? "Ardia's registry turned it off";

export function resetRevocationsForTests(given: RegistryRevocationsPayload | null = null) {
  list = given;
  seq = given?.seq ?? -1;
  persistedSeq = seq;
  envelope = null;
  loaded = given !== null;
}
