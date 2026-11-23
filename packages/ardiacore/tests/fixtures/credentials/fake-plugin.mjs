import { createInterface } from "node:readline";

const waiting = new Map();
let next = 0;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function request(method, params) {
  const id = ++next;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, items: [], lines: [] });
    send({ id, method, params });
  });
}

const verb = (call, name, params) => request("credentials.verb", { call, verb: name, params });

const handlers = {
  async state(input, ctx, call) {
    const status = await verb(call, "status", ctx.session?.key ? { session: ctx.session.key } : {});
    if (!status.succeeded) return { state: "unavailable", problem: "failed", detail: status.stderr };
    const name = status.json?.status;
    if (name === "unlocked") return { state: ctx.session?.key ? "unlocked" : "locked", account: status.json.userEmail, server: { preset: "us" } };
    if (name === "locked") return { state: "locked", account: status.json.userEmail, server: { preset: "us" } };
    return { state: "signedOut" };
  },
  async signIn(input, ctx, call) {
    const result = await verb(call, "login", { email: input.fields.email, password: input.fields.masterPassword });
    if (result.unlocked) return { ok: true };
    if (result.hints.includes("wrongCredentials")) return { ok: false, problem: "wrongCredentials", state: "signedOut", field: "masterPassword" };
    return { ok: false, problem: "failed", detail: result.stderr };
  },
  async unlock(input, ctx, call) {
    if (!input.password) return { ok: false, need: { kind: "field", field: "masterPassword" } };
    const result = await verb(call, "unlock", { password: input.password });
    return result.unlocked ? { ok: true } : { ok: false, need: { kind: "field", field: "masterPassword" }, problem: "wrongPassword" };
  },
  async signOut() {
    return null;
  },
  async list(input, ctx, call) {
    if (!ctx.session?.key) throw { code: "locked" };
    const result = await verb(call, "list.items", { session: ctx.session.key, count: "3" });
    if (!result.succeeded) throw { code: "locked" };
    const items = result.collected.map((entry) => ({
      id: entry.id,
      title: entry.name,
      username: entry.login.username,
      urls: entry.login.uris.map((uri) => uri.uri),
      secrets: { password: entry.login.password },
    }));
    return { snapshot: "s1", items };
  },
  async reveal(input, ctx, call) {
    const result = await verb(call, "get.password", { session: ctx.session.key, id: input.id });
    if (!result.succeeded) throw { code: "notFound" };
    return { password: result.lines[0] };
  },
  async save() {
    throw { code: "unsupported" };
  },
};

async function answer(message) {
  const handler = handlers[message.name];
  try {
    const result = await handler(message.input, message.context, message.call);
    await request("result", { call: message.call, result: result ?? null });
  } catch (error) {
    const wire = error && typeof error.code === "string" ? { code: error.code } : { code: "failed", problem: "failed", detail: String(error?.message ?? error) };
    await request("result", { call: message.call, error: wire });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (typeof message.verbOf === "number") {
    const waiter = waiting.get(message.verbOf);
    if (waiter && "item" in message) waiter.items.push(message.item);
    if (waiter && message.line) waiter.lines.push(message.line);
    return;
  }
  if (typeof message.id === "number" && !message.method) {
    const waiter = waiting.get(message.id);
    waiting.delete(message.id);
    if (!waiter) return;
    if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else waiter.resolve({ ...message.result, collected: waiter.items });
    return;
  }
  if (typeof message.call === "string" && !message.cancel) answer(message);
});

await request("hello", { protocol: 2, sdk: "2.1.0", credentials: 1 });
await request("ready", { commands: [], tools: [], views: [], omnibox: false, decide: [], events: [], credentialProvider: { handlers: Object.keys(handlers) } });
