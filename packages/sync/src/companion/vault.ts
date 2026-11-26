import { visible } from "../scope.ts";
import type { Adapter, ScopeState } from "../scopeState.ts";
import { VAULT_ANSWER, VAULT_KEY, VAULT_PREFIX, VAULT_REQUEST, vaultAnswerFor, vaultAnswerOf, vaultChallenge, vaultRequestOf, vaultTrustKey, vaultTrustOf, type VaultAnswerRecord, type VaultKeyRecord, type VaultRequestRecord } from "../vaultApproval.ts";

export type ViewVaultRequest = {
  id: string;
  program: string;
  sites: string[];
  why: string;
  profileName: string;
  alwaysOffered: boolean;
  trusted: boolean;
  askedAt: number;
  expiresAt: number;
  fromDeviceId: string;
  fromDevice: string | null;
};

export type VaultPhoneContext = { me: string; key: () => VaultKeyRecord | null; answers: () => VaultAnswerRecord[]; drop: (ids: Set<string>) => void };

export function vaultAnswersAdapter(ctx: VaultPhoneContext): Adapter {
  return {
    prefix: VAULT_PREFIX,
    extract: (_base, _queued, now, _known, remote) => {
      const values = new Map<string, unknown>();
      const gone = new Set<string>();
      for (const answer of ctx.answers()) {
        const asked = vaultRequestOf(`${VAULT_REQUEST}${answer.id}`, remote(`${VAULT_REQUEST}${answer.id}`));
        if (!asked || answer.x <= now) gone.add(answer.id);
        else values.set(`${VAULT_ANSWER}${answer.id}`, answer);
      }
      if (gone.size) ctx.drop(gone);
      const key = ctx.key();
      if (key) values.set(`${VAULT_KEY}${ctx.me}`, key);
      return {
        values,
        ignore: (k) => !values.has(k),
        published: (keys) => ctx.drop(new Set([...keys].filter((k) => k.startsWith(VAULT_ANSWER)).map((k) => k.slice(VAULT_ANSWER.length)))),
      };
    },
    apply: () => true,
  };
}

export function openVaultRequests(app: ScopeState | undefined, answered: Iterable<string>, now: number, me: string): VaultRequestRecord[] {
  if (!app) return [];
  const done = new Set(answered);
  for (const [k, v] of visible(app, VAULT_ANSWER)) if (vaultAnswerOf(k, v)?.by === me) done.add(k.slice(VAULT_ANSWER.length));
  const out: VaultRequestRecord[] = [];
  for (const [k, v] of visible(app, VAULT_REQUEST)) {
    const request = vaultRequestOf(k, v);
    if (request && request.x > now && !done.has(request.id)) out.push(request);
  }
  return out.sort((a, z) => a.at - z.at || (a.id < z.id ? -1 : 1));
}

export function trustedBy(app: ScopeState | undefined, me: string, mac: string, key: VaultKeyRecord | null): boolean {
  if (!app || !key) return false;
  const hint = vaultTrustKey(me, mac);
  return vaultTrustOf(hint, visible(app, hint).get(hint))?.f === key.f;
}

export function vaultRequestsView(app: ScopeState | undefined, answered: Iterable<string>, now: number, me: string, key: VaultKeyRecord | null): ViewVaultRequest[] {
  if (!app) return [];
  const names = new Map<string, string>();
  for (const [k, v] of visible(app, "dev:")) {
    const n = (v as { n?: unknown } | null)?.n;
    if (typeof n === "string") names.set(k.slice(4), n);
  }
  return openVaultRequests(app, answered, now, me).map((r) => ({
    id: r.id,
    program: r.g,
    sites: [...r.s],
    why: r.w,
    profileName: r.pn,
    alwaysOffered: r.ao,
    trusted: trustedBy(app, me, r.m, key),
    askedAt: r.at,
    expiresAt: r.x,
    fromDeviceId: r.m,
    fromDevice: names.get(r.m) ?? null,
  }));
}

type AnswerInput = { id: string; allow: boolean; always: boolean; at: number };

const openRequest = (app: ScopeState | undefined, answers: VaultAnswerRecord[], input: AnswerInput, me: string) =>
  openVaultRequests(app, answers.map((a) => a.id), input.at, me).find((r) => r.id === input.id) ?? null;

export function vaultChallengeFor(app: ScopeState | undefined, answers: VaultAnswerRecord[], input: AnswerInput, me: string): string | null {
  const request = openRequest(app, answers, input, me);
  return request ? vaultChallenge(request, me, input.allow === true, input.always === true) : null;
}

export function answerVaultRequest(app: ScopeState | undefined, answers: VaultAnswerRecord[], input: AnswerInput & { sig?: string | null }, me: string): VaultAnswerRecord | null {
  const request = openRequest(app, answers, input, me);
  const allow = input.allow === true;
  if (!request || (allow && (typeof input.sig !== "string" || !input.sig))) return null;
  const answer = vaultAnswerFor(request, allow, input.always === true, me, input.at, allow ? (input.sig as string) : "");
  answers.push(answer);
  return answer;
}
