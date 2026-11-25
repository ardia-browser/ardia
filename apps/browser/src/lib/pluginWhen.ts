const WHEN_KEYS = ["urlHost", "urlScheme", "isPinned", "isInGroup", "isSplit", "isActive", "tabCount"] as const;
type WhenKey = (typeof WHEN_KEYS)[number];
type WhenValue = string | number | boolean;
export type WhenContext = Partial<Record<WhenKey, WhenValue>>;

export const MAX_WHEN_LENGTH = 200;
const MAX_DEPTH = 16;
const MAX_GLOB = 128;

type Literal = { kind: "literal"; value: WhenValue };
type Key = { kind: "key"; key: WhenKey };
type Operand = Literal | Key;
type WhenExpr =
  | Operand
  | { kind: "not"; of: WhenExpr }
  | { kind: "and" | "or"; left: WhenExpr; right: WhenExpr }
  | { kind: "compare"; op: "==" | "!=" | "~="; left: Operand; right: Operand };

type Token = { type: "op"; value: string } | { type: "string"; value: string } | { type: "number"; value: number } | { type: "word"; value: string };

type WhenParse = { ok: true; expr: WhenExpr } | { ok: false; problem: string };

const OPERATORS = ["&&", "||", "==", "!=", "~=", "!", "(", ")"];
const WORD = /[A-Za-z_]/;
const WORD_REST = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

function tokenize(source: string): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      tokens.push({ type: "op", value: op });
      i += op.length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = source.indexOf(ch, i + 1);
      if (end < 0) return "has a string without its closing quote";
      tokens.push({ type: "string", value: source.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (DIGIT.test(ch) || (ch === "-" && DIGIT.test(source[i + 1] ?? ""))) {
      let end = i + 1;
      while (end < source.length && /[0-9.]/.test(source[end]!)) end++;
      const value = Number(source.slice(i, end));
      if (!Number.isFinite(value)) return `has a bad number at ${i}`;
      tokens.push({ type: "number", value });
      i = end;
      continue;
    }
    if (WORD.test(ch)) {
      let end = i + 1;
      while (end < source.length && WORD_REST.test(source[end]!)) end++;
      tokens.push({ type: "word", value: source.slice(i, end) });
      i = end;
      continue;
    }
    return `has an unexpected ${JSON.stringify(ch)} at ${i}`;
  }
  return tokens;
}

class Parser {
  private at = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): WhenExpr {
    const expr = this.or(0);
    if (this.at < this.tokens.length) throw new Error(`has something unexpected after position ${this.at}`);
    return expr;
  }

  private peekOp(value: string) {
    const t = this.tokens[this.at];
    return t?.type === "op" && t.value === value;
  }

  private or(depth: number): WhenExpr {
    let left = this.and(depth);
    while (this.peekOp("||")) {
      this.at++;
      left = { kind: "or", left, right: this.and(depth) };
    }
    return left;
  }

  private and(depth: number): WhenExpr {
    let left = this.unary(depth);
    while (this.peekOp("&&")) {
      this.at++;
      left = { kind: "and", left, right: this.unary(depth) };
    }
    return left;
  }

  private unary(depth: number): WhenExpr {
    if (depth > MAX_DEPTH) throw new Error(`nests deeper than ${MAX_DEPTH}`);
    if (this.peekOp("!")) {
      this.at++;
      return { kind: "not", of: this.unary(depth + 1) };
    }
    if (this.peekOp("(")) {
      this.at++;
      const inner = this.or(depth + 1);
      if (!this.peekOp(")")) throw new Error("has a ( without its )");
      this.at++;
      return inner;
    }
    const left = this.operand();
    const t = this.tokens[this.at];
    if (t?.type === "op" && (t.value === "==" || t.value === "!=" || t.value === "~=")) {
      this.at++;
      return { kind: "compare", op: t.value, left, right: this.operand() };
    }
    return left;
  }

  private operand(): Operand {
    const t = this.tokens[this.at++];
    if (!t) throw new Error("ends too soon");
    if (t.type === "string" || t.type === "number") return { kind: "literal", value: t.value };
    if (t.type === "word") {
      if (t.value === "true" || t.value === "false") return { kind: "literal", value: t.value === "true" };
      if ((WHEN_KEYS as readonly string[]).includes(t.value)) return { kind: "key", key: t.value as WhenKey };
      throw new Error(`names ${t.value}, which isn't one of ${WHEN_KEYS.join(", ")}`);
    }
    throw new Error(`has ${t.value} where a key or value goes`);
  }
}

export function parseWhen(source: string): WhenParse {
  if (typeof source !== "string" || !source.trim()) return { ok: false, problem: "is empty" };
  if (source.length > MAX_WHEN_LENGTH) return { ok: false, problem: `is over ${MAX_WHEN_LENGTH} characters` };
  const tokens = tokenize(source);
  if (typeof tokens === "string") return { ok: false, problem: tokens };
  try {
    return { ok: true, expr: new Parser(tokens).parse() };
  } catch (error) {
    return { ok: false, problem: (error as Error).message };
  }
}

export function globMatches(pattern: string, value: string): boolean {
  if (pattern.length > MAX_GLOB || value.length > 2048) return false;
  let p = 0;
  let v = 0;
  let star = -1;
  let mark = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === value[v]) {
      p++;
      v++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = v;
    } else if (star >= 0) {
      p = star + 1;
      v = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

const valueOf = (o: Operand, context: WhenContext): WhenValue | undefined => (o.kind === "literal" ? o.value : context[o.key]);
const truthy = (v: WhenValue | undefined) => (typeof v === "string" ? v.length > 0 : typeof v === "number" ? v !== 0 : v === true);

function same(a: WhenValue | undefined, b: WhenValue | undefined): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  return String(a ?? "") === String(b ?? "");
}

export function evaluateWhen(expr: WhenExpr, context: WhenContext): boolean {
  switch (expr.kind) {
    case "literal":
    case "key":
      return truthy(valueOf(expr, context));
    case "not":
      return !evaluateWhen(expr.of, context);
    case "and":
      return evaluateWhen(expr.left, context) && evaluateWhen(expr.right, context);
    case "or":
      return evaluateWhen(expr.left, context) || evaluateWhen(expr.right, context);
    case "compare": {
      const left = valueOf(expr.left, context);
      const right = valueOf(expr.right, context);
      if (expr.op === "==") return same(left, right);
      if (expr.op === "!=") return !same(left, right);
      return globMatches(String(right ?? "").toLowerCase(), String(left ?? "").toLowerCase());
    }
  }
}

const parsed = new Map<string, WhenParse>();

export function whenHolds(source: string | undefined | null, context: WhenContext): boolean {
  if (!source) return true;
  let read = parsed.get(source);
  if (!read) {
    read = parseWhen(source);
    if (parsed.size > 512) parsed.clear();
    parsed.set(source, read);
  }
  return read.ok && evaluateWhen(read.expr, context);
}
