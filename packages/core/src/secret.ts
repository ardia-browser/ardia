export const SECRET_KINDS = ["password", "oauthToken", "oauthClientSecret", "apiToken", "pluginSecret", "syncPhrase", "devtoolsToken"] as const;

export type SecretKind = (typeof SECRET_KINDS)[number];

type SecretEscape = "json" | "text" | "telemetry" | "log" | "sync" | "socket";

type SecretEscapeMode = "throw" | "drop";

export const REDACTED_SECRET = "<secret>";

const plaintext = new WeakMap<object, string>();
const kinds = new WeakMap<object, SecretKind>();
const listeners = new Set<(where: SecretEscape, kind: SecretKind) => void>();
let mode: SecretEscapeMode = "drop";
let dropped = 0;

export class SecretEscapeError extends Error {
  readonly where: SecretEscape;
  readonly kind: SecretKind;

  constructor(where: SecretEscape, kind: SecretKind) {
    super(`A ${kind} secret reached a ${where} sink`);
    this.name = "SecretEscapeError";
    this.where = where;
    this.kind = kind;
  }
}

export class Secret<K extends SecretKind = SecretKind> {
  private readonly secretKind?: K;

  private constructor() {}

  get kind(): K {
    return kinds.get(this) as K;
  }

  toJSON(): undefined {
    noteSecretEscape("json", this);
    return undefined;
  }

  toString(): string {
    noteSecretEscape("text", this);
    return REDACTED_SECRET;
  }

  valueOf(): string {
    return this.toString();
  }
}

Object.defineProperty(Secret.prototype, Symbol.toPrimitive, { value: Secret.prototype.toString });
Object.defineProperty(Secret.prototype, Symbol.for("nodejs.util.inspect.custom"), { value: () => `Secret(${REDACTED_SECRET})` });

export function asSecret<K extends SecretKind>(kind: K, value: string): Secret<K> {
  if (typeof value !== "string") throw new TypeError("A secret is text");
  if (!SECRET_KINDS.includes(kind)) throw new TypeError("Unknown secret kind");
  const box = Object.create(Secret.prototype) as Secret<K>;
  plaintext.set(box, value);
  kinds.set(box, kind);
  Object.freeze(box);
  return box;
}

export const isSecret = (value: unknown): value is Secret => typeof value === "object" && value !== null && plaintext.has(value);

export function reveal(secret: Secret): string {
  const value = plaintext.get(secret);
  if (value === undefined) throw new TypeError("Not a secret");
  return value;
}

export const sameSecret = (a: Secret | null | undefined, b: Secret | null | undefined): boolean =>
  !!a && !!b && (a === b || (a.kind === b.kind && reveal(a) === reveal(b)));

export function noteSecretEscape(where: SecretEscape, secret: Secret): void {
  const kind = kinds.get(secret) ?? "password";
  if (mode === "throw") throw new SecretEscapeError(where, kind);
  dropped++;
  for (const listener of listeners) {
    try {
      listener(where, kind);
    } catch {}
  }
}

export function setSecretEscapeMode(next: SecretEscapeMode): SecretEscapeMode {
  const previous = mode;
  mode = next;
  return previous;
}

export function onSecretEscape(listener: (where: SecretEscape, kind: SecretKind) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const secretsDropped = () => dropped;

export function withoutSecrets<T>(value: T, where: SecretEscape, seen = new WeakSet<object>()): T {
  if (isSecret(value)) {
    noteSecretEscape(where, value);
    return undefined as T;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const kept = withoutSecrets(item, where, seen);
      if (kept !== item) changed = true;
      return kept;
    });
    return (changed ? out : value) as T;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  let out: Record<string, unknown> | null = null;
  for (const [key, item] of Object.entries(value)) {
    const kept = withoutSecrets(item, where, seen);
    if (kept === item) continue;
    out ??= { ...(value as Record<string, unknown>) };
    if (kept === undefined) delete out[key];
    else out[key] = kept;
  }
  return (out ?? value) as T;
}

type IsAny<T> = 0 extends 1 & T ? true : false;
type Shallower = [never, 0, 1, 2, 3, 4, 5];

type ContainsSecret<T, Depth extends number = 6> =
  IsAny<T> extends true
    ? false
    : [Depth] extends [never]
      ? false
      : T extends Secret
        ? true
        : T extends (...args: never[]) => unknown
          ? false
          : T extends readonly (infer Item)[]
            ? ContainsSecret<Item, Shallower[Depth]>
            : T extends object
              ? true extends { [K in keyof T]-?: ContainsSecret<T[K], Shallower[Depth]> }[keyof T]
                ? true
                : false
              : false;

export type SecretFree<T> = true extends ContainsSecret<T> ? never : T;
