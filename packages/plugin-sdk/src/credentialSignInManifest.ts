import { Checks, isFields, KEY, KEY_RULE, P } from "./credentialManifestChecks";
import type { CredentialSignIn, SignInField, SignInFieldType, SignInMethod, SignInMethodKind, SignInServer } from "./credentialManifestTypes";

const S = `${P}.signIn`;
const FIELD_TYPES: readonly SignInFieldType[] = ["text", "email", "secret"];
const METHOD_KINDS: readonly SignInMethodKind[] = ["fields", "desktopApproval", "browserApproval"];
const APP_URL = /^[a-z][a-z0-9+.-]{1,30}:\/\/$/;
const HOST = /^[a-z0-9.-]{1,253}$/;
const LIMITS = { methods: 4, fields: 6, servers: 6, hosts: 8, title: 40, placeholder: 60, hint: 120 } as const;

function fieldOf(c: Checks, path: string, value: unknown): SignInField | null {
  const doc = c.object(path, value);
  if (!doc) return null;
  c.only(path, doc, ["id", "title", "type", "placeholder", "hint", "optional", "prefill", "masked"]);
  const id = c.matching(`${path}.id`, doc.id, KEY, KEY_RULE);
  const title = c.text(`${path}.title`, doc.title, LIMITS.title);
  const type = (FIELD_TYPES as readonly unknown[]).includes(doc.type) ? (doc.type as SignInFieldType) : (c.add(`${path}.type must be text, email or secret`), null);
  const placeholder = c.text(`${path}.placeholder`, doc.placeholder, LIMITS.placeholder, false);
  const hint = c.text(`${path}.hint`, doc.hint, LIMITS.hint, false);
  const optional = c.flag(`${path}.optional`, doc.optional, false);
  const prefill = doc.prefill === undefined ? null : doc.prefill === "account" ? "account" : (c.add(`${path}.prefill must be account`), null);
  if (doc.masked !== undefined && type !== null && type !== "secret") c.add(`${path}.masked only goes with type secret`);
  const masked = type === "secret" ? c.flag(`${path}.masked`, doc.masked, true) : false;
  if (!id || !title || !type) return null;
  return { id, title, type, optional, masked, ...(placeholder ? { placeholder } : {}), ...(hint ? { hint } : {}), ...(prefill ? { prefill } : {}) };
}

function methodOf(c: Checks, path: string, value: unknown, needsHosts: () => void): SignInMethod | null {
  const doc = c.object(path, value);
  if (!doc) return null;
  c.only(path, doc, ["id", "title", "kind", "fields", "twoStep", "appURL", "appTitle"]);
  const id = c.matching(`${path}.id`, doc.id, KEY, KEY_RULE);
  const title = c.text(`${path}.title`, doc.title, LIMITS.title);
  const kind = doc.kind === undefined ? "fields" : (METHOD_KINDS as readonly unknown[]).includes(doc.kind) ? (doc.kind as SignInMethodKind) : (c.add(`${path}.kind must be fields, desktopApproval or browserApproval`), null);
  const raw = kind === "fields" ? c.list(`${path}.fields`, doc.fields, 1, LIMITS.fields) : c.list(`${path}.fields`, doc.fields, 0, LIMITS.fields);
  const fields = (raw ?? []).flatMap((f, i) => fieldOf(c, `${path}.fields[${i}]`, f) ?? []);
  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f.id)) c.add(`${path}.fields has two fields named ${f.id}`);
    seen.add(f.id);
  }
  if (doc.twoStep !== undefined && kind !== null && kind !== "fields") c.add(`${path}.twoStep only goes with kind fields`);
  const twoStep = kind === "fields" ? c.flag(`${path}.twoStep`, doc.twoStep, false) : false;
  const desktop = kind === "desktopApproval";
  if (!desktop && doc.appURL !== undefined) c.add(`${path}.appURL only goes with kind desktopApproval`);
  if (!desktop && doc.appTitle !== undefined) c.add(`${path}.appTitle only goes with kind desktopApproval`);
  const appURL = desktop ? c.matching(`${path}.appURL`, doc.appURL, APP_URL, "an app's address, like onepassword://") : null;
  const appTitle = desktop ? c.text(`${path}.appTitle`, doc.appTitle, LIMITS.title) : null;
  if (kind === "browserApproval") needsHosts();
  if (!id || !title || !kind || !raw || (desktop && (!appURL || !appTitle))) return null;
  return { id, title, kind, fields, twoStep, ...(appURL ? { appURL } : {}), ...(appTitle ? { appTitle } : {}) };
}

function serverOf(c: Checks, path: string, value: unknown): SignInServer | null {
  const doc = c.object(path, value);
  if (!doc) return null;
  c.only(path, doc, ["id", "title", "custom"]);
  const id = c.matching(`${path}.id`, doc.id, KEY, KEY_RULE);
  const title = c.text(`${path}.title`, doc.title, LIMITS.title);
  let custom: SignInServer["custom"] | null = null;
  if (doc.custom !== undefined) {
    const spec = c.object(`${path}.custom`, doc.custom);
    if (spec) {
      c.only(`${path}.custom`, spec, ["title", "placeholder"]);
      const customTitle = c.text(`${path}.custom.title`, spec.title, LIMITS.title);
      const placeholder = c.text(`${path}.custom.placeholder`, spec.placeholder, LIMITS.placeholder, false);
      if (customTitle) custom = { title: customTitle, ...(placeholder ? { placeholder } : {}) };
    }
  }
  if (!id || !title || (doc.custom !== undefined && !custom)) return null;
  return { id, title, ...(custom ? { custom } : {}) };
}

function unique(c: Checks, path: string, ids: readonly string[], what: string) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) c.add(`${path} has two ${what} named ${id}`);
    seen.add(id);
  }
}

function fieldTypeProblems(c: Checks, methods: readonly SignInMethod[]) {
  const types = new Map<string, SignInFieldType>();
  for (const method of methods) {
    for (const field of method.fields) {
      const first = types.get(field.id);
      if (first && first !== field.type) c.add(`${S} has a field ${field.id} that is ${first} in one method and ${field.type} in another`);
      else types.set(field.id, field.type);
    }
  }
}

function hostsOf(c: Checks, value: unknown, needed: boolean, firstNeeding: number): string[] {
  if (value === undefined) {
    if (needed) c.add(`${S}.methods[${firstNeeding}] needs ${S}.approvalHosts`);
    return [];
  }
  const raw = c.list(`${S}.approvalHosts`, value, 1, LIMITS.hosts) ?? [];
  return raw.flatMap((host, i) => c.matching(`${S}.approvalHosts[${i}]`, host, HOST, "a host name, like proton.me") ?? []);
}

export function signInOf(c: Checks, value: unknown): CredentialSignIn | null {
  if (!isFields(value)) return (c.add(`${S} must be an object`), null);
  c.only(S, value, ["methods", "servers", "unlock", "approvalHosts"]);
  const needing: number[] = [];
  const rawMethods = c.list(`${S}.methods`, value.methods, 1, LIMITS.methods);
  const methods = (rawMethods ?? []).flatMap((m, i) => methodOf(c, `${S}.methods[${i}]`, m, () => needing.push(i)) ?? []);
  unique(c, `${S}.methods`, methods.map((m) => m.id), "methods");
  fieldTypeProblems(c, methods);
  const servers = (c.list(`${S}.servers`, value.servers, 0, LIMITS.servers) ?? []).flatMap((s, i) => serverOf(c, `${S}.servers[${i}]`, s) ?? []);
  unique(c, `${S}.servers`, servers.map((s) => s.id), "servers");
  if (servers.filter((s) => s.custom).length > 1) c.add(`${S}.servers has two custom servers`);
  let unlock: CredentialSignIn["unlock"] = null;
  if (value.unlock !== undefined) {
    const doc = c.object(`${S}.unlock`, value.unlock);
    if (doc) {
      c.only(`${S}.unlock`, doc, ["field"]);
      const secret = methods.some((m) => m.fields.some((f) => f.id === doc.field && f.type === "secret"));
      if (!secret) c.add(`${S}.unlock.field must name a secret field of ${S}.methods`);
      else unlock = { field: doc.field as string };
    }
  }
  const approvalHosts = hostsOf(c, value.approvalHosts, needing.length > 0, needing[0] ?? 0);
  return rawMethods ? { methods, servers, unlock, approvalHosts } : null;
}
