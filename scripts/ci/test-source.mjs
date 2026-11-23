import { createHash } from "node:crypto";

const JS_PUNCT = ["===", "!==", "**=", "...", "<<=", ">>=", ">>>", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>"];
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);
const IDENT_START = /[A-Za-z_$\u0080-\uffff]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-\uffff]/;
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
const TYPE_PARAMETERS = /^<[A-Za-z_$][\w$]*\s*(?:,|extends\s)/;

export function languageOf(path) {
  if (/\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/.test(path)) return "js";
  if (/\.swift$/.test(path)) return "swift";
  return null;
}

const CONTROL_WORDS = new Set(["if", "while", "for", "with"]);

function regexAllowed(previous, beforePrevious) {
  if (!previous) return true;
  if (previous.type === "word" && previous.text === "of") return beforePrevious?.type === "word" || ["]", "}"].includes(beforePrevious?.text);
  if (previous.type === "template") return !previous.closed;
  if (previous.type === "punct" && previous.text === ")") return Boolean(previous.control);
  if (previous.type === "punct") return !["]", "++", "--"].includes(previous.text);
  if (previous.type === "word") return REGEX_AFTER_WORD.has(previous.text);
  return false;
}

function tokenizeJs(source, { jsx = false } = {}) {
  return lexJs(source, 0, false, jsx).tokens;
}

function jsxText(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  return lines
    .map((line, index) => {
      let kept = index > 0 ? line.replace(/^[ \t]+/, "") : line;
      if (index < lines.length - 1) kept = kept.replace(/[ \t]+$/, "");
      return kept;
    })
    .filter((line) => lines.length === 1 || line.length)
    .join(" ");
}

function scanJsx(source, start) {
  let index = start;
  let depth = 0;
  let text = "";
  const expression = (at) => {
    const { tokens, end } = lexJs(source, at + 1, true, true);
    return { end: end + 1, text: `{${normalize(tokens)}}` };
  };
  for (;;) {
    const closingTag = source[index + 1] === "/";
    let tag = "<";
    let space = false;
    let selfClosing = false;
    const add = (piece) => {
      if (space && !/[=</]$/.test(tag) && !/^[=/>]/.test(piece)) tag += " ";
      space = false;
      tag += piece;
    };
    index++;
    while (index < source.length) {
      const char = source[index];
      if (char === '"' || char === "'") {
        const end = source.indexOf(char, index + 1);
        if (end < 0) throw new Error(`unterminated JSX attribute at ${index}`);
        add(source.slice(index, end + 1));
        index = end + 1;
      } else if (char === "{") {
        const inner = expression(index);
        add(inner.text);
        index = inner.end;
      } else if (/\s/.test(char)) {
        space = true;
        index++;
      } else if (char === "/" && source[index + 1] === ">") {
        add("/>");
        selfClosing = true;
        index += 2;
        break;
      } else if (char === ">") {
        add(">");
        index++;
        break;
      } else {
        add(char);
        index++;
      }
    }
    text += tag;
    if (closingTag) depth--;
    else if (!selfClosing) depth++;
    if (depth <= 0) return { end: index, text };
    let raw = "";
    while (index < source.length && source[index] !== "<") {
      if (source[index] === "{") {
        text += jsxText(raw);
        raw = "";
        const inner = expression(index);
        text += inner.text;
        index = inner.end;
      } else raw += source[index++];
    }
    text += jsxText(raw);
    if (index >= source.length) throw new Error(`unterminated JSX element at ${start}`);
  }
}

function lexJs(source, from, untilBrace, jsx) {
  const tokens = [];
  const stack = [];
  const parens = [];
  const pendingDo = [];
  let at = from;
  let newline = false;
  const push = (type, start, end, extra = {}) => {
    tokens.push({ type, text: source.slice(start, end), start, end, newline, ...extra });
    newline = false;
  };
  const scanTemplate = (start) => {
    let index = start;
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") index += 2;
      else if (char === "`") return { end: index + 1, open: false };
      else if (char === "$" && source[index + 1] === "{") return { end: index + 2, open: true };
      else index++;
    }
    throw new Error(`unterminated template literal at ${start}`);
  };
  while (at < source.length) {
    const char = source[at];
    const next = source[at + 1];
    if (/\s/.test(char)) {
      if (LINE_TERMINATOR.test(char)) newline = true;
      at++;
      continue;
    }
    if (char === "/" && next === "/") {
      while (at < source.length && source[at] !== "\n") at++;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", at + 2);
      if (end < 0) throw new Error(`unterminated comment at ${at}`);
      if (LINE_TERMINATOR.test(source.slice(at, end))) newline = true;
      at = end + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      let index = at + 1;
      while (index < source.length && source[index] !== char) {
        if (source[index] === "\\") {
          index += source.startsWith("\r\n", index + 1) ? 3 : 2;
          continue;
        }
        if (source[index] === "\n" || source[index] === "\r") throw new Error(`unterminated string at ${at}`);
        index++;
      }
      push("string", at, index + 1);
      at = index + 1;
      continue;
    }
    if (char === "`" || (char === "}" && stack.at(-1) === "template")) {
      if (char === "}") stack.pop();
      const { end, open } = scanTemplate(at + 1);
      push("template", at, end, { head: char === "`", closed: !open });
      if (open) stack.push("template");
      at = end;
      continue;
    }
    if (untilBrace && char === "}" && !stack.length) return { tokens, end: at };
    if (jsx && char === "<" && /[A-Za-z>]/.test(next ?? "") && !TYPE_PARAMETERS.test(source.slice(at, at + 80)) && regexAllowed(tokens.at(-1), tokens.at(-2))) {
      const { end, text } = scanJsx(source, at);
      push("jsx", at, end, { text });
      at = end;
      continue;
    }
    if (char === "/" && regexAllowed(tokens.at(-1), tokens.at(-2))) {
      let index = at + 1;
      let inClass = false;
      while (index < source.length) {
        const current = source[index];
        if (current === "\\") index++;
        else if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) break;
        else if (current === "\n") throw new Error(`unterminated regular expression at ${at}`);
        index++;
      }
      index++;
      while (index < source.length && IDENT_PART.test(source[index])) index++;
      push("regex", at, index);
      at = index;
      continue;
    }
    if (IDENT_START.test(char)) {
      let index = at + 1;
      while (index < source.length && IDENT_PART.test(source[index])) index++;
      const word = source.slice(at, index);
      const member = tokens.at(-1)?.text === "." || tokens.at(-1)?.text === "?.";
      if (word === "do" && !member) pendingDo.push(stack.length);
      const closesDo = word === "while" && !member && pendingDo.at(-1) === stack.length;
      if (closesDo) pendingDo.pop();
      push("word", at, index, closesDo ? { closesDo } : {});
      at = index;
      continue;
    }
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(next ?? ""))) {
      let index = at + 1;
      while (index < source.length && /[0-9A-Za-z_.]/.test(source[index])) index++;
      push("number", at, index);
      at = index;
      continue;
    }
    if (char === "{") stack.push("brace");
    if (char === "}") stack.pop();
    const long = JS_PUNCT.find((punct) => source.startsWith(punct, at));
    const end = at + (long ? long.length : 1);
    const previous = tokens.at(-1);
    if (char === "(") {
      const forAwait = previous?.text === "await" && tokens.at(-2)?.text === "for";
      parens.push(previous?.type === "word" && !previous.closesDo && (CONTROL_WORDS.has(previous.text) || forAwait));
    }
    push("punct", at, end, char === ")" ? { control: parens.pop() === true } : {});
    at = end;
  }
  if (untilBrace) throw new Error(`unterminated JSX expression at ${from}`);
  return { tokens, end: at };
}

function tokenizeSwift(source) {
  const tokens = [];
  let at = 0;
  let newline = false;
  const push = (type, start, end) => {
    tokens.push({ type, text: source.slice(start, end), start, end, newline });
    newline = false;
  };
  const skipString = (start) => {
    const hashes = source.slice(start).match(/^#*/)[0];
    const triple = source.startsWith('"""', start + hashes.length);
    const closer = `${triple ? '"""' : '"'}${hashes}`;
    const escape = `\\${hashes}`;
    let index = start + hashes.length + (triple ? 3 : 1);
    while (index < source.length) {
      if (source.startsWith(`${escape}(`, index)) {
        index = skipInterpolation(index + escape.length + 1);
        continue;
      }
      if (source.startsWith(escape, index)) {
        index += escape.length + 1;
        continue;
      }
      if (source.startsWith(closer, index)) return index + closer.length;
      if (!triple && source[index] === "\n") throw new Error(`unterminated string at ${start}`);
      index++;
    }
    throw new Error(`unterminated string at ${start}`);
  };
  const skipInterpolation = (start) => {
    let depth = 1;
    let index = start;
    while (index < source.length) {
      if (source[index] === '"' || (source[index] === "#" && /^#+"/.test(source.slice(index, index + 16)))) {
        index = skipString(index);
        continue;
      }
      if (source[index] === "(") depth++;
      if (source[index] === ")" && --depth === 0) return index + 1;
      index++;
    }
    throw new Error(`unterminated interpolation at ${start}`);
  };
  while (at < source.length) {
    const char = source[at];
    const next = source[at + 1];
    if (/\s/.test(char)) {
      if (char === "\n") newline = true;
      at++;
      continue;
    }
    if (char === "/" && next === "/") {
      while (at < source.length && source[at] !== "\n") at++;
      continue;
    }
    if (char === "/" && next === "*") {
      const commentStart = at;
      let depth = 1;
      at += 2;
      while (at < source.length && depth > 0) {
        if (source.startsWith("/*", at)) {
          depth++;
          at += 2;
        } else if (source.startsWith("*/", at)) {
          depth--;
          at += 2;
        } else at++;
      }
      if (source.slice(commentStart, at).includes("\n")) newline = true;
      continue;
    }
    if (char === '"' || (char === "#" && /^#+"/.test(source.slice(at, at + 16)))) {
      const end = skipString(at);
      push("string", at, end);
      at = end;
      continue;
    }
    if (char === "`") {
      const end = source.indexOf("`", at + 1);
      if (end < 0) throw new Error(`unterminated identifier at ${at}`);
      push("word", at, end + 1);
      at = end + 1;
      continue;
    }
    if (IDENT_START.test(char) || char === "@" || char === "#") {
      let index = at + 1;
      while (index < source.length && IDENT_PART.test(source[index])) index++;
      push("word", at, index);
      at = index;
      continue;
    }
    if (/[0-9]/.test(char)) {
      let index = at + 1;
      while (index < source.length && /[0-9A-Za-z_.]/.test(source[index])) index++;
      push("number", at, index);
      at = index;
      continue;
    }
    push("punct", at, at + 1);
    at++;
  }
  return tokens;
}

function closing(tokens, openAt) {
  const open = tokens[openAt].text;
  const close = { "(": ")", "{": "}", "[": "]" }[open];
  let depth = 0;
  for (let index = openAt; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== "punct") continue;
    if (token.text === open) depth++;
    else if (token.text === close) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function opening(tokens, closeAt) {
  const close = tokens[closeAt].text;
  const open = { ")": "(", "}": "{", "]": "[" }[close];
  let depth = 0;
  for (let index = closeAt; index >= 0; index--) {
    const token = tokens[index];
    if (token.type !== "punct") continue;
    if (token.text === close) depth++;
    else if (token.text === open && --depth === 0) return index;
  }
  return -1;
}

const OPENERS = new Set(["(", "{", "["]);
const CLOSERS = new Set([")", "}", "]"]);
const JS_STARTS = new Set(["import", "export", "const", "let", "var", "for", "if", "while", "do", "switch", "try", "function", "class", "return", "throw", "describe", "suite", "test", "it", "before", "after", "beforeEach", "afterEach"]);
const SWIFT_STARTS = new Set(["import", "let", "var", "func", "struct", "class", "enum", "extension", "actor", "protocol", "final", "public", "private", "internal", "fileprivate", "static"]);
const SWIFT_MODIFIERS = /^(?:public|private|internal|fileprivate|static|final|override|mutating|nonisolated|class)$/;

const CONTINUING_WORDS = new Set(["else", "do", "await", "return", "yield", "void", "typeof", "new", "in", "of", "instanceof", "delete", "throw", "case"]);

function labelEnd(tokens, at) {
  let depth = 0;
  let ternaries = 0;
  for (let index = at + 1; index < tokens.length; index++) {
    const text = tokens[index].type === "punct" ? tokens[index].text : null;
    if (text && OPENERS.has(text)) depth++;
    else if (text && CLOSERS.has(text)) depth--;
    else if (text === "?" && depth === 0) ternaries++;
    else if (text === ":" && depth === 0 && ternaries) ternaries--;
    else if (text === ":" && depth === 0) return index;
    else if (text === ";" && depth === 0) return -1;
    if (depth < 0) return -1;
  }
  return -1;
}

function ancestry(tokens, language) {
  const stack = [];
  const boundary = [0];
  const prepend = new Map();
  const chains = new Map();
  const labels = new Map();
  const attributeEnd = (at) => {
    const token = tokens[at];
    if (!token) return false;
    if (token.text.startsWith("@") || SWIFT_MODIFIERS.test(token.text)) return true;
    if (token.text !== ")") return false;
    const open = opening(tokens, at);
    return open > 0 && tokens[open - 1].text.startsWith("@");
  };
  const inBlock = () => !stack.length || tokens[stack.at(-1).opener].text === "{";
  const labelEnds = new Map();
  const ended = new Map();
  const inSwitch = () => {
    if (!stack.length) return false;
    const opener = stack.at(-1).opener;
    if (tokens[opener].text !== "{" || tokens[opener - 1]?.text !== ")") return false;
    return tokens[opening(tokens, opener - 1) - 1]?.text === "switch";
  };
  const continues = (previous) =>
    previous.control || (previous.type === "punct" && ![";", "}", ")", "]"].includes(previous.text)) || (previous.type === "word" && CONTINUING_WORDS.has(previous.text));
  const startsStatement = (index) => {
    const token = tokens[index];
    if (!token.newline || index === 0 || !inBlock()) return false;
    if (language === "js") return token.type === "word" && JS_STARTS.has(token.text) && !continues(tokens[index - 1]);
    if (!(SWIFT_STARTS.has(token.text) || token.text.startsWith("@") || token.text.startsWith("#"))) return false;
    return !attributeEnd(index - 1);
  };
  const setBoundary = (at) => {
    boundary[boundary.length - 1] = at;
  };
  const forget = (depth) => {
    for (const map of [chains, labels, labelEnds, ended]) for (const key of map.keys()) if (key > depth) map.delete(key);
  };
  const slice = (start, end) => [...(prepend.get(start) ?? []), ...tokens.slice(start, end)];
  return {
    take(index) {
      const token = tokens[index];
      const depth = boundary.length;
      if (startsStatement(index)) setBoundary(index);
      if (language === "js" && token.type === "word" && inBlock()) {
        if (token.text === "if" && tokens[index + 1]?.text === "(") {
          chains.set(depth, slice(boundary.at(-1), closing(tokens, index + 1) + 1));
        } else if (token.text === "else") {
          prepend.set(index, [...(chains.get(depth) ?? [])]);
          setBoundary(index);
        } else if (["break", "return", "throw", "continue"].includes(token.text) && inSwitch()) {
          ended.set(depth, true);
        } else if ((token.text === "case" || token.text === "default") && inSwitch() && (token.newline || ["{", ";", ":", "}"].includes(tokens[index - 1]?.text))) {
          const end = labelEnd(tokens, index);
          if (end > index) {
            const shared = labelEnds.get(depth) === index - 1 || !ended.get(depth);
            ended.set(depth, false);
            labels.set(depth, [...(shared ? (labels.get(depth) ?? []) : []), ...tokens.slice(index, end + 1)]);
            labelEnds.set(depth, end);
            setBoundary(index);
          }
        }
      }
      if (token.type !== "punct") return;
      if (OPENERS.has(token.text)) {
        stack.push({ start: boundary.at(-1), opener: index });
        boundary.push(index + 1);
      } else if (CLOSERS.has(token.text)) {
        stack.pop();
        boundary.pop();
        if (!boundary.length) boundary.push(index + 1);
        forget(boundary.length);
        const next = tokens[index + 1];
        if (token.text === "}" && next && inBlock() && (next.type === "word" || (next.newline && next.type !== "punct"))) setBoundary(index + 1);
      } else if (token.text === ";") setBoundary(index + 1);
    },
    headers(index) {
      const headers = stack.map(({ start, opener }) => slice(start, opener + 1));
      for (const key of [...labels.keys()].sort((x, y) => x - y)) headers.push(labels.get(key));
      if (language === "js") headers.push(slice(boundary.at(-1), index));
      return headers;
    },
  };
}

const SIMPLE_ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };

function decodeString(body) {
  return body.replace(/\\(?:x([0-9A-Fa-f]{2})|u\{([0-9A-Fa-f]+)\}|u([0-9A-Fa-f]{4})|(\r\n|[\n\r\u2028\u2029])|([\s\S]))/g, (match, hex, codePoint, unit, continuation, other) => {
    if (hex || unit) return String.fromCharCode(parseInt(hex || unit, 16));
    if (codePoint) return String.fromCodePoint(parseInt(codePoint, 16));
    if (continuation) return "";
    return SIMPLE_ESCAPES[other] ?? other;
  });
}

function stringValue(token) {
  if (token.type === "template") return token.head && token.closed ? token.text.slice(1, -1).replace(/\\`/g, "`") : null;
  if (token.type !== "string" || token.text.startsWith('"""')) return null;
  return decodeString(token.text.slice(1, -1));
}

function titleAt(source, tokens, at) {
  const first = tokens[at];
  if (first.type !== "template" || !first.head || first.closed) return stringValue(first);
  let depth = 0;
  for (let index = at; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== "template") continue;
    if (token.head && !token.closed) depth++;
    else if (!token.head && token.closed && --depth === 0) return source.slice(first.start + 1, token.end - 1);
  }
  return null;
}

const JS_CALLS = new Set(["test", "it", "describe", "suite"]);
const JS_GROUPS = new Set(["describe", "suite"]);

function findJsTests(path, source) {
  const tokens = tokenizeJs(source, { jsx: /\.[jt]sx$/.test(path) });
  const found = [];
  const groups = [];
  const context = ancestry(tokens, "js");
  for (let index = 0; index < tokens.length; index++) {
    while (groups.length && groups.at(-1).end < index) groups.pop();
    context.take(index);
    const token = tokens[index];
    if (token.type !== "word" || !JS_CALLS.has(token.text)) continue;
    if (tokens[index - 1]?.text === "." || tokens[index - 1]?.text === "?.") continue;
    let open = index + 1;
    while (tokens[open]?.text === "." && tokens[open + 1]?.type === "word" && ["only", "skip", "todo"].includes(tokens[open + 1].text)) open += 2;
    if (tokens[open]?.text !== "(") continue;
    const name = tokens[open + 1] && titleAt(source, tokens, open + 1);
    if (typeof name !== "string") continue;
    const end = closing(tokens, open);
    if (end < 0) throw new Error(`no closing parenthesis for "${name}"`);
    if (JS_GROUPS.has(token.text)) {
      groups.push({ name, end });
      continue;
    }
    found.push({ name, path: [...groups.map((group) => group.name), name].join(" › "), language: "js", context: context.headers(index), tokens: tokens.slice(index, end + 1) });
  }
  return found;
}

function directiveLine(tokens, at) {
  let end = at + 1;
  while (end < tokens.length && !tokens[end].newline) end++;
  return tokens.slice(at, end);
}

function findSwiftTests(source) {
  const tokens = tokenizeSwift(source);
  const found = [];
  const context = ancestry(tokens, "swift");
  const directives = [];
  for (let index = 0; index < tokens.length; index++) {
    context.take(index);
    const text = tokens[index].text;
    if (text === "#if") directives.push(directiveLine(tokens, index));
    else if ((text === "#elseif" || text === "#else") && directives.length) directives[directives.length - 1] = [...directives.at(-1), ...directiveLine(tokens, index)];
    else if (text === "#endif") directives.pop();
    if (tokens[index].text !== "func" || tokens[index + 1]?.type !== "word") continue;
    const raw = tokens[index + 1].text;
    const name = raw.startsWith("`") ? raw.slice(1, -1) : raw;
    let start = index;
    for (;;) {
      const previous = tokens[start - 1];
      if (!previous) break;
      if (SWIFT_MODIFIERS.test(previous.text) || previous.text.startsWith("@")) {
        start--;
        continue;
      }
      if (previous.text === ")") {
        const open = opening(tokens, start - 1);
        if (open > 0 && tokens[open - 1].text.startsWith("@")) {
          start = open - 1;
          continue;
        }
      }
      break;
    }
    const markedTest = tokens.slice(start, index).some((token) => token.text === "@Test");
    if (!markedTest && !/^test/.test(name)) continue;
    let open = index + 2;
    while (open > 0 && open < tokens.length && !["{", "}"].includes(tokens[open].text) && !(tokens[open].text === "func" || (tokens[open].newline && /^(?:func|var|let|@|#)/.test(tokens[open].text)))) {
      if (tokens[open].text === "(") open = closing(tokens, open);
      open++;
    }
    if (open <= 0 || tokens[open]?.text !== "{") continue;
    const end = closing(tokens, open);
    if (end < 0) throw new Error(`no closing brace for ${name}`);
    found.push({ name, path: name, language: "swift", context: [...directives, ...context.headers(index)], tokens: tokens.slice(start, end + 1) });
  }
  return found;
}

export function findTests(path, source) {
  const language = languageOf(path);
  if (language === "js") return findJsTests(path, source);
  if (language === "swift") return findSwiftTests(source);
  throw new Error(`${path}: only JavaScript, TypeScript and Swift tests can be read`);
}

function normalizedToken(token) {
  if (token.type === "string" && /^'[^'"\\]*'$|^"[^'"\\]*"$/.test(token.text)) return `"${token.text.slice(1, -1)}"`;
  return token.text;
}

const RESTRICTED = new Set(["return", "break", "continue", "yield", "throw", "async"]);
const OPENING = new Set(["(", "[", "{", ","]);

export function normalize(tokens, language = "js") {
  const out = [];
  tokens.forEach((token, index) => {
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    if (token.type === "punct" && token.text === "," && CLOSERS.has(next?.text) && previous && !OPENING.has(previous.text)) return;
    if (language === "js" && token.newline && previous && ((previous.type === "word" && RESTRICTED.has(previous.text)) || token.text === "++" || token.text === "--")) out.push(";");
    out.push(normalizedToken(token));
  });
  return out.join(" ");
}

export function hashOf(test) {
  const context = (test.context ?? []).map((header) => normalize(header, test.language)).join("\n");
  return createHash("sha256").update(`${context}\n\n${normalize(test.tokens, test.language)}`).digest("hex").slice(0, 16);
}

export function pickTest(tests, wanted) {
  const byPath = tests.filter((test) => test.path === wanted);
  if (byPath.length === 1) return { test: byPath[0] };
  const byName = tests.filter((test) => test.name === wanted);
  if (byName.length === 1) return { test: byName[0] };
  const squeeze = (text) => text.replace(/\$\{[^}]*\}/g, (part) => part.replace(/\s+/g, ""));
  const loose = byPath.length + byName.length || !wanted.includes("${") ? [] : tests.filter((test) => squeeze(test.path) === squeeze(wanted) || squeeze(test.name) === squeeze(wanted));
  if (loose.length === 1) return { test: loose[0] };
  if (byPath.length + byName.length + loose.length > 1) return { error: `more than one test is called "${wanted}"; name it by its describe path (outer › inner)` };
  return { error: `no test called "${wanted}"` };
}
