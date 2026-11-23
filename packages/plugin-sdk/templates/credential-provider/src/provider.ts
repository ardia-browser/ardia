import {
  CredentialError,
  SignIn,
  isSecretHandle,
  json,
  verbs,
  type CredentialContext,
  type CredentialProvider,
  type ListedItem,
  type ProviderState,
  type RevealField,
  type Revealed,
  type SecretHandle,
  type VerbResult,
} from "@ardia/plugin-sdk/credentials";

const HINTS = { locked: ["vault is locked"], signedOut: ["not logged in"], notFound: ["not found"] };

const check = (result: VerbResult, ctx: CredentialContext) => verbs.check(result, HINTS, ctx.offline);

function sessionOf(ctx: CredentialContext): SecretHandle {
  const key = ctx.session.current?.key;
  if (!key) throw CredentialError.locked();
  return key;
}

function itemOf(raw: unknown): ListedItem | null {
  const entry = json.dict(raw);
  const id = json.string(entry?.id);
  if (!entry || !id) return null;
  return { id, title: json.string(entry.name) ?? id, username: json.string(entry.username) ?? "", urls: json.strings(entry.urls), hasTotp: json.bool(entry.hasTotp) ?? false };
}

async function state(ctx: CredentialContext): Promise<ProviderState> {
  const result = await ctx.cli.verb("status", { session: ctx.session.current?.key ?? undefined });
  check(result, ctx);
  const status = json.record(result.json);
  const account = json.string(status.email);
  if (json.string(status.status) === "signedOut") return { state: "signedOut" };
  return { state: json.string(status.status) === "unlocked" && ctx.session.current ? "unlocked" : "locked", ...(account ? { account } : {}) };
}

async function reveal(ctx: CredentialContext, id: string, fields: readonly RevealField[]): Promise<Revealed> {
  const session = sessionOf(ctx);
  const revealed: Revealed = {};
  for (const field of fields) {
    const result = await ctx.cli.verb("get", { session, field, id });
    check(result, ctx);
    const value = result.lines[0] ?? "";
    if (field === "totp") revealed.totp = { uri: value };
    else revealed[field] = value;
  }
  return revealed;
}

export const vaultctl: CredentialProvider = {
  state: (_request, ctx) => state(ctx),
  async signIn(request, ctx) {
    const { email, password } = request.fields;
    if (typeof email !== "string" || !isSecretHandle(password)) return SignIn.needs({ kind: "field", field: "password" });
    const result = await ctx.cli.verb("login", { email, password });
    if (result.hints.includes("wrongPassword")) return SignIn.failed("wrongCredentials", { field: "password" });
    check(result, ctx);
    await ctx.preferences.set("account", email);
    return result.unlocked ? SignIn.done() : SignIn.failed("stayedLocked");
  },
  async unlock(request, ctx) {
    if (!request.password) return SignIn.needs({ kind: "field", field: "password" });
    const result = await ctx.cli.verb("unlock", { password: request.password });
    if (result.hints.includes("wrongPassword")) return SignIn.failed("wrongPassword", { field: "password" });
    if (result.hints.includes("signedOut")) return SignIn.failed("signInFirst", { state: "signedOut" });
    check(result, ctx);
    return result.unlocked ? SignIn.done() : SignIn.failed("stayedLocked");
  },
  async signOut(_request, ctx) {
    check(await ctx.cli.verb("logout", { session: ctx.session.current?.key ?? undefined }), ctx);
  },
  async list(_request, ctx) {
    const items: ListedItem[] = [];
    const onItem = (raw: unknown) => {
      const item = itemOf(raw);
      if (item) items.push(item);
    };
    const result = await ctx.cli.verb("list", { session: sessionOf(ctx) }, { onItem });
    check(result, ctx);
    return items;
  },
  reveal: ({ id, fields }, ctx) => reveal(ctx, id, fields),
};
