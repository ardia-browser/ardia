const EXPIRY_MARK = /@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\s+until\s+(\d{4}-\d{2}-\d{2})(?=:|\s|$)/;
const EXPIRY_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const OWNER = /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

const DEADLINE =
  /\b(?:deadline|SECONDS|EPOCHSECONDS|Date\.now|performance\.now|monotonic|perf_counter|time\.time|hrtime|attempts?|tries|retries|[Ee]lapsed|waited|max_?wait|maxWait|give_?up|giveUp|budget|expired|ends?At)\b|date\s+\+%s|Get-Date|Stopwatch/;
const GIVES_UP = /\b(?:break|exit|return|throw|raise|die|fail|Write-Error)\b/;

const ALSO_NEEDS = /&&|\s-and\s|\band\b/;

function boundedBody(body) {
  const lines = body.split("\n");
  return lines.some((line, k) => {
    if (!DEADLINE.test(line) || !GIVES_UP.test(lines.slice(k, k + 3).join("\n"))) return false;
    const condition = line.replace(/&&\s*\{?\s*(?:break|exit|return|throw|die|fail)\b[\s\S]*$/, "");
    return !ALSO_NEEDS.test(condition);
  });
}
const SHELL_COUNTED = /-(?:lt|le|gt|ge)\b|\(\([^)]*[<>]/;
const COMPARISON = /[^=<>!-][<>]=?[^=>]/;

const lineOf = (text, at) => {
  let line = 1;
  for (let k = 0; k < at; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
};

function lineStarts(text) {
  const starts = [0];
  for (let k = 0; k < text.length; k++) if (text.charCodeAt(k) === 10) starts.push(k + 1);
  return starts;
}

function basicRegex(pattern) {
  const translated = pattern.replace(/\\([(){}+?|])|([(){}+?|])/g, (_, escaped, plain) => (escaped ? escaped : `\\${plain}`));
  try {
    return new RegExp(translated);
  } catch {
    return null;
  }
}

function shellHelpLines(src, strings, context = src) {
  const singleQuoted = strings.filter((s) => s.kind === "single");
  const lines = src.split("\n");
  const exempt = new Set();
  const starts = lineStarts(src);
  const aliases = [...src.matchAll(/^[ \t]*(?:local[ \t]+|readonly[ \t]+)?([A-Za-z_]\w*)=[^\n]*(?:\$0\b|\$\{0\}|BASH_SOURCE)/gm)].map((match) => match[1]);
  const selfPath = new RegExp(String.raw`\$(?:0\b|\{0\}|\{BASH_SOURCE(?:\[0\])?\}|BASH_SOURCE\b${aliases.map((name) => `|${name}\\b|\\{${name}\\}`).join("")})`, "g");
  for (const match of src.matchAll(selfPath)) {
    if (singleQuoted.some((s) => match.index >= s.start && match.index < s.end)) continue;
    const lineIndex = starts.findLastIndex((start) => start <= match.index);
    const line = lines[lineIndex];
    if (!/(?:^|[;&|({]|\b(?:then|do|else)\b|\)\s)\s*(?:sed|head|awk|grep|cat|tail|less|more)\b/.test(line) || /(?:^|[^&\d])>\s*\/dev\/null/.test(line)) continue;
    if (!HELP_CONTEXT.test(context.split("\n").slice(Math.max(0, lineIndex - 3), lineIndex + 2).join("\n"))) continue;
    const range = /\bsed\b[^|;]*?-n\s+['"]?(\d+)\s*,\s*(\d+|\/[^/]*\/|\$)p/.exec(line);
    const head = /\bhead\s+(?:-n\s*|-)(\d+)/.exec(line);
    let from = 1;
    let to = 0;
    if (range) {
      from = Number(range[1]);
      if (/^\d+$/.test(range[2])) to = Number(range[2]);
      else if (range[2] === "$") to = lines.length;
      else {
        const pattern = basicRegex(range[2].slice(1, -1));
        to = pattern ? lines.findIndex((text, k) => k + 1 > from && pattern.test(text)) : -1;
        to = to < 0 ? lines.length : to + 1;
      }
    } else if (head) to = Number(head[1]);
    else {
      from = lines[0].startsWith("#!") ? 2 : 1;
      to = from;
      while (to <= lines.length && /^\s*#/.test(lines[to - 1])) to++;
      to--;
    }
    const header = leadingBlock(src, /^\s*#/);
    for (let k = Math.max(1, from); k <= Math.min(to, lines.length); k++) if (header.has(k)) exempt.add(k);
  }
  return exempt;
}

const READS_ITSELF = /readFileSync\(\s*(?:fileURLToPath\(\s*)?(?:new URL\(\s*)?import\.meta\.(?:url|filename)|readFileSync\(\s*(?:__filename|process\.argv\[1\])/g;
const HELP_CONTEXT = /--help\b|(?:^|[\s'"(|])-h\b|help|usage|\bexit\s*\(?\s*64\b/i;
const PRINTS = /\bconsole\.(?:log|error|info)\s*\(|\bprocess\.std(?:out|err)\.write\s*\(/;

const SELF_PATH = /\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:fileURLToPath\(\s*import\.meta\.url\s*\)|import\.meta\.filename|__filename|process\.argv\[1\])/g;

function printsItself(src, context) {
  const aliases = [...context.matchAll(SELF_PATH)].map((match) => match[1].replace(/\$/g, "\\$"));
  const reads = aliases.length ? [READS_ITSELF, new RegExp(String.raw`readFileSync\(\s*(?:${aliases.join("|")})\b`, "g")] : [READS_ITSELF];
  const printsHelp = (at) => {
    const after = context.slice(at, at + 400);
    const stripsMarkers = /\.split\(/.test(after) && /["'\x60]\/\/|\\\/\\\//.test(after);
    return stripsMarkers && PRINTS.test(context.slice(context.lastIndexOf("\n", at) + 1, at + 400)) && HELP_CONTEXT.test(context.slice(Math.max(0, at - 600), at + 400));
  };
  for (const pattern of reads) {
    for (const match of context.matchAll(pattern)) {
      if (!printsHelp(match.index)) continue;
      const chain = /\.split\([^)]*\)\s*(?:\[(\d+)\]|\.slice\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?/.exec(context.slice(match.index, match.index + 400));
      if (chain?.[1] !== undefined) return (line) => line === Number(chain[1]) + 1;
      if (chain?.[2] !== undefined) return (line) => line > Number(chain[2]) && (chain[3] === undefined || line <= Number(chain[3]));
      return () => true;
    }
  }
  return null;
}

function leadingBlock(src, marker) {
  const lines = src.split("\n");
  const exempt = new Set();
  for (let k = lines[0]?.startsWith("#!") ? 1 : 0; k < lines.length && marker.test(lines[k]); k++) exempt.add(k + 1);
  return exempt;
}

export function helpExempt(lang, src, scan, sourcedPrinters = new Set()) {
  if (lang === "js") {
    const printed = printsItself(src, scan.codeAndStrings ?? src);
    if (!printed) return () => false;
    const lines = leadingBlock(src, /^\/\//);
    return (range) => {
      const line = lineOf(src, range[0]);
      return lines.has(line) && printed(line);
    };
  }
  if (lang === "shell") {
    const lines = sourcedPrinters.size ? leadingBlock(src, /^\s*#/) : shellHelpLines(src, scan.strings, scan.codeAndStrings ?? src);
    return (range) => lines.has(lineOf(src, range[0]));
  }
  const selfPrint = lang === "python" ? /\bprint\([^\n]*(?:\bopen\(\s*(?:__file__|sys\.argv\[0\])|Path\(\s*__file__\s*\)\.read_text)/.exec(scan.codeAndStrings ?? src) : null;
  if (selfPrint && HELP_CONTEXT.test((scan.codeAndStrings ?? src).slice(Math.max(0, selfPrint.index - 300), selfPrint.index + 300))) {
    const lines = leadingBlock(src, /^#/);
    return (range) => lines.has(lineOf(src, range[0]));
  }
  if (lang === "python") {
    const usesDoc = /\b__doc__\b/.test(scan.code);
    const moduleDoc = scan.docstrings[0];
    const isModuleDoc = moduleDoc && !/\S/.test(scan.code.slice(0, moduleDoc[0]).replace(/^#!.*/, ""));
    return (range) => usesDoc && isModuleDoc && range[0] === moduleDoc[0];
  }
  if (lang === "powershell") return (range) => scan.help.some((help) => help[0] === range[0]);
  return () => false;
}

const SHELL_PREFIX_WORDS = new Set(["do", "then", "else", "elif", "time", "!", "if", "while", "until"]);

function commandWords(code) {
  const words = [];
  for (const segment of code.matchAll(/[^;&|()\n{}`]+/g)) {
    for (const word of segment[0].matchAll(/\S+/g)) {
      words.push({ word: word[0], at: segment.index + word.index });
      if (!SHELL_PREFIX_WORDS.has(word[0])) break;
    }
  }
  return words;
}

function shellLoops(code) {
  const loops = [];
  const stack = [];
  for (const { word, at } of commandWords(code)) {
    if (word === "do") {
      const open = stack.findLast((loop) => loop.bodyStart < 0);
      if (open) open.bodyStart = at + 2;
    } else if (word === "done") {
      const loop = stack.pop();
      if (loop) {
        loop.end = at;
        loops.push(loop);
      }
    } else if (word === "for" || word === "while" || word === "until" || word === "select") stack.push({ kind: word, start: at, bodyStart: -1, end: code.length });
  }
  loops.push(...stack);
  return loops.filter((loop) => loop.bodyStart >= 0);
}

const NOT_COUNTERS = new Set(["for", "while", "until", "do", "if", "in", "of", "let", "const", "var", "true", "false", "null", "undefined", "length", "test", "and", "or", "not", "is", "None", "True", "False"]);

function advances(header, body) {
  const clauses = header.split(";");
  const condition = clauses.length >= 3 ? clauses[1] : header;
  const names = [...new Set([...condition.matchAll(/\$?\{?([A-Za-z_][\w]*)/g)].map((match) => match[1]))].filter((name) => !NOT_COUNTERS.has(name));
  const text = `${clauses.length >= 3 ? clauses.slice(2).join(";") : header}\n${body}`;
  return names.some((name) =>
    new RegExp(String.raw`(?:\+\+|--)\s*\$?${name}\b|(?<![\w.])\$?${name}\s*(?:\+\+|--|[-+*/]?=(?!=))|\blet\s+${name}\b|\b(?:read|shift)\b[^\n]*\b${name}\b`).test(text),
  );
}

function counted(header, body) {
  return DEADLINE.test(header) || advances(header, body);
}

function shellBounded(code, loop, loops) {
  const header = code.slice(loop.start, loop.bodyStart);
  const body = ownBody(code, loop, loops);
  if (loop.kind === "for" && !/^for\s*\(\(/.test(header)) return true;
  return (SHELL_COUNTED.test(header) && counted(header, body)) || DEADLINE.test(header) || boundedBody(body);
}

function innermost(loops, at) {
  return loops.filter((loop) => at >= loop.bodyStart && at < loop.end).sort((a, b) => b.bodyStart - a.bodyStart)[0];
}

export function shellSleeps(code) {
  const loops = shellLoops(code);
  let found = 0;
  for (const { word, at } of commandWords(code)) {
    if (word !== "sleep" || !/^sleep[ \t]+[^\s;&|)]/.test(code.slice(at, at + 40))) continue;
    const loop = innermost(loops, at);
    if (!loop || !shellBounded(code, loop, loops)) found++;
  }
  return found;
}

export function powershellSleeps(code) {
  const loops = braceLoops(code, /\b(foreach|for|while|do|until)\b(?=\s*[({])/gi);
  let found = 0;
  for (const match of code.matchAll(/(?<=(?:^|[;{(|&])[ \t]*)Start-Sleep\b/gim)) {
    const loop = innermost(loops, match.index);
    if (!loop || !braceBounded(code, loop, loops)) found++;
  }
  return found;
}

export function pythonSleeps(code) {
  const lines = code.split("\n");
  const importsSleep = /^\s*from\s+(?:time|asyncio)\s+import\s+[^\n]*\bsleep\b/m.test(code);
  const sleep = importsSleep ? /(?:\b(?:time|asyncio)\s*\.\s*|(?<![.\w]))sleep\s*\(/ : /\b(?:time|asyncio)\s*\.\s*sleep\s*\(/;
  const indentOf = (line) => line.match(/^\s*/)[0].length;
  let found = 0;
  lines.forEach((line, k) => {
    if (!sleep.test(line)) return;
    let indent = indentOf(line);
    for (let j = k - 1; j >= 0; j--) {
      const above = lines[j];
      if (!above.trim() || indentOf(above) >= indent) continue;
      indent = indentOf(above);
      const header = above.trim();
      if (/^(?:async\s+)?(?:def|class)\b/.test(header)) break;
      if (/^(?:async\s+)?for\b/.test(header)) return;
      if (/^while\b/.test(header)) {
        let end = j + 1;
        while (end < lines.length && (!lines[end].trim() || indentOf(lines[end]) > indent)) end++;
        const own = [];
        let nested = Infinity;
        for (const body of lines.slice(j + 1, end)) {
          if (body.trim() && indentOf(body) <= nested) nested = Infinity;
          if (nested !== Infinity) continue;
          if (/^\s*(?:async\s+)?(?:for|while)\b/.test(body)) nested = indentOf(body);
          else own.push(body);
        }
        if ((COMPARISON.test(header.replace(/->/g, "")) && counted(header, own.join("\n"))) || DEADLINE.test(header) || boundedBody(own.join("\n"))) return;
        break;
      }
      if (indent === 0) break;
    }
    found++;
  });
  return found;
}

function balanced(code, at, open, close) {
  let depth = 0;
  for (let k = at; k < code.length; k++) {
    if (code[k] === open) depth++;
    else if (code[k] === close && --depth === 0) return k;
  }
  return code.length;
}

function statementEnd(code, at) {
  let depth = 0;
  for (let k = at; k < code.length; k++) {
    const c = code[k];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth <= 0 && (c === ";" || c === "\n")) return k;
  }
  return code.length;
}

function braceLoops(code, pattern) {
  const loops = [];
  const doTails = new Set();
  for (const match of code.matchAll(pattern)) {
    if (doTails.has(match.index)) continue;
    const keyword = (match[1] ?? match[2]).replace(/\s+await$/, "").toLowerCase();
    let at = match.index + match[0].length;
    while (at < code.length && /\s/.test(code[at])) at++;
    let header = "";
    if (keyword !== "do" && code[at] === "(") {
      const headerEnd = balanced(code, at, "(", ")");
      header = code.slice(at, headerEnd + 1);
      at = headerEnd + 1;
      while (at < code.length && /\s/.test(code[at])) at++;
    }
    const end = code[at] === "{" ? balanced(code, at, "{", "}") : statementEnd(code, at);
    if (keyword === "do") {
      const tail = /^\s*(?:while|until)\s*\(/i.exec(code.slice(end + 1, end + 40));
      if (tail) {
        doTails.add(end + 1 + tail[0].search(/\S/));
        const open = end + tail[0].length;
        const close = balanced(code, open, "(", ")");
        header = code.slice(open, close + 1);
        loops.push({ kind: keyword, header, start: match.index, bodyStart: at, end, tailEnd: close + 1 });
        continue;
      }
    }
    loops.push({ kind: keyword, header, start: match.index, bodyStart: at, end, tailEnd: end });
  }
  return loops;
}

function ownBody(code, loop, loops) {
  let body = code.slice(loop.bodyStart, loop.end);
  for (const inner of loops) {
    const innerEnd = Math.max(inner.end, inner.tailEnd ?? inner.end);
    if (inner === loop || inner.start < loop.bodyStart || innerEnd > loop.end) continue;
    const from = inner.start - loop.bodyStart;
    const to = innerEnd - loop.bodyStart;
    body = body.slice(0, from) + body.slice(from, to).replace(/[^\n]/g, " ") + body.slice(to);
  }
  return body;
}

function braceBounded(code, loop, loops) {
  const { kind, header } = loop;
  if ((kind === "for" || kind === "foreach") && /\b(?:of|in)\b/.test(header)) return true;
  const body = ownBody(code, loop, loops);
  if (DEADLINE.test(header)) return true;
  if ((COMPARISON.test(header.replace(/=>|->/g, "")) || /-(?:lt|le|gt|ge)\b/i.test(header)) && counted(header, body)) return true;
  return boundedBody(body);
}

const TIMER_HELPER = [
  /\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\(\s*([\w$]*)\s*(?::\s*number)?\s*\)|([\w$]+))\s*(?::\s*[\w<>]+\s*)?=>\s*new\s+Promise\s*(?:<[^>]*>)?\s*\(\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*\{?\s*setTimeout\s*\(\s*\4\s*,\s*([\w$.]+)\s*\)/g,
  /\bfunction\s+([\w$]+)\s*\(\s*([\w$]*)[^)]*\)\s*(?::\s*[^{]+)?\{\s*return\s+new\s+Promise\s*(?:<[^>]*>)?\s*\(\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*\{?\s*setTimeout\s*\(\s*\3\s*,\s*([\w$.]+)\s*\)/g,
];
const TIMERS_PROMISES = /\bimport\s*\{[^}]*\bsetTimeout(?:\s+as\s+([\w$]+))?[^}]*\}\s*from\s*["'](?:node:)?timers\/promises["']/g;

function timerHelpers(codeAndStrings) {
  const names = new Set(["sleep"]);
  for (const match of codeAndStrings.matchAll(TIMER_HELPER[0])) {
    const param = match[2] || match[3];
    if (match[5] === param || /^[1-9]\d*$/.test(match[5])) names.add(match[1]);
    else if (match[5] === "0") names.delete(match[1]);
  }
  for (const match of codeAndStrings.matchAll(TIMER_HELPER[1])) {
    if (match[4] === match[2] || /^[1-9]\d*$/.test(match[4])) names.add(match[1]);
    else if (match[4] === "0") names.delete(match[1]);
  }
  for (const match of codeAndStrings.matchAll(TIMERS_PROMISES)) names.add(match[1] ?? "setTimeout");
  return names;
}

export function jsSleeps(code, codeAndStrings) {
  const names = timerHelpers(codeAndStrings);
  const loops = braceLoops(code, /\b(for(?:\s+await)?|while)\b(?=\s*\()|\b(do)\b(?=\s*[\w{(\[!])/g);
  const alternatives = [...names].map((name) => name.replace(/\$/g, "\\$")).join("|");
  const sites = [
    ...code.matchAll(new RegExp(String.raw`\bawait\s+(?:${alternatives})\s*\((?!\s*0\s*\))`, "g")),
    ...code.matchAll(/\bawait\s+new\s+Promise\s*(?:<[^>]*>)?\s*\(\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*\{?\s*setTimeout\s*\(\s*\1\s*,(?!\s*0\s*\))/g),
  ];
  let found = 0;
  for (const match of sites) {
    const fence = functionStart(code, match.index);
    const loop = innermost(loops.filter((candidate) => candidate.bodyStart > fence), match.index);
    if (!loop || !braceBounded(code, loop, loops)) found++;
  }
  return found;
}

const NOT_FUNCTION_HEAD = /\b(?:if|for|while|switch|catch|with|return|typeof|await|yield|in|of)\s*$/;

function functionStart(code, at) {
  let depth = 0;
  for (let k = at - 1; k >= 0; k--) {
    const c = code[k];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth > 0) {
        depth--;
        continue;
      }
      if (c !== "{") continue;
      const before = code.slice(Math.max(0, k - 200), k).trimEnd();
      if (before.endsWith("=>")) return k;
      if (before.endsWith(")")) {
        let parens = 0;
        let open = before.length - 1;
        for (; open >= 0; open--) {
          if (before[open] === ")") parens++;
          else if (before[open] === "(" && --parens === 0) break;
        }
        if (open >= 0 && !NOT_FUNCTION_HEAD.test(before.slice(0, open))) return k;
      }
    } else if (depth === 0 && c === ">" && code[k - 1] === "=") return k;
  }
  return -1;
}

function unmatchedOpen(code, at) {
  let depth = 0;
  for (let k = at - 1; k >= 0; k--) {
    const c = code[k];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth === 0) return k;
      depth--;
    }
  }
  return -1;
}

function boundObjectName(code, at) {
  const bag = unmatchedOpen(code, at);
  if (bag < 0 || code[bag] !== "{") return null;
  return /\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=;]+)?=\s*$/.exec(code.slice(Math.max(0, bag - 120), bag))?.[1] ?? null;
}

function topLevelArgs(code, open) {
  const close = balanced(code, open, "(", ")");
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let k = open + 1; k < close; k++) {
    const c = code[k];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      args.push(code.slice(start, k).trim());
      start = k + 1;
    }
  }
  args.push(code.slice(start, close).trim());
  return args;
}

function passedToTestCall(code, callees) {
  const passed = new Set();
  for (const match of code.matchAll(new RegExp(String.raw`(?<![\w$.])(?:[\w$]+\.)?(?:${callees})(?:\s*\.\s*[\w$]+)?\s*\(`, "g"))) {
    for (const arg of topLevelArgs(code, match.index + match[0].length - 1)) if (/^[A-Za-z_$][\w$]*$/.test(arg)) passed.add(arg);
  }
  return (name) => name !== null && passed.has(name);
}

function optionBagCallee(code, at) {
  const bag = unmatchedOpen(code, at);
  if (bag < 0 || code[bag] !== "{" || !/[(,]\s*$/.test(code.slice(Math.max(0, bag - 40), bag))) return "";
  const call = unmatchedOpen(code, bag);
  if (call < 0 || code[call] !== "(") return "";
  return /([\w$.]+)\s*$/.exec(code.slice(Math.max(0, call - 60), call))?.[1] ?? "";
}

const NODE_TEST_ALIASES = /\bimport\s*\*\s*as\s+([\w$]+)\s*from\s*["'](?:node:)?test["']|\bimport\s+([\w$]+)\s*(?:,\s*\{[^}]*\})?\s*from\s*["'](?:node:)?test["']|\b(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*["'](?:node:)?test["']\s*\)/g;

function testCallees(codeAndStrings) {
  const names = new Set(["test", "it", "describe", "suite", "context"]);
  for (const match of codeAndStrings.matchAll(NODE_TEST_ALIASES)) names.add(match[1] ?? match[2] ?? match[3]);
  for (const match of codeAndStrings.matchAll(NODE_TEST_IMPORT)) {
    for (const part of (match[1] ?? match[2]).split(",")) {
      const renamed = /^\s*(?:test|it|describe|suite)\s*(?:as|:)\s*([\w$]+)\s*$/.exec(part);
      if (renamed) names.add(renamed[1]);
    }
  }
  return names;
}

function stringAfter(strings, src, at, limit = Infinity) {
  const s = strings.find((str) => str.start > at && str.start <= limit);
  return s ? src.slice(s.start, s.end) : null;
}

const NODE_TEST_IMPORT = /\bimport\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["'](?:node:)?test["']|\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*["'](?:node:)?test["']\s*\)/g;

function nodeTestShorthands(codeAndStrings) {
  const names = new Map();
  for (const match of codeAndStrings.matchAll(NODE_TEST_IMPORT)) {
    for (const part of (match[1] ?? match[2]).split(",")) {
      const named = /^\s*(skip|todo|only)(?:\s*(?:as|:)\s*([\w$]+))?\s*$/.exec(part);
      if (named) names.set(named[2] ?? named[1], named[1]);
    }
  }
  return names;
}

function constantValue(code, codeAndStrings, strings, src, name, at) {
  const pattern = new RegExp(String.raw`\b(?:const|let|var)\s+${name.replace(/\$/g, "\\$")}\s*(?::\s*[\w$.<>|\s]+?)?=\s*`, "g");
  let best = null;
  for (const binding of codeAndStrings.matchAll(pattern)) {
    const scope = unmatchedOpen(code, binding.index);
    const scopeEnd = scope < 0 ? code.length : balanced(code, scope, "{", "}");
    if (at < scope || at > scopeEnd) continue;
    if (best && (scope < best.scope || (scope === best.scope && binding.index < best.index))) continue;
    best = { scope, index: binding.index, valueAt: binding.index + binding[0].length };
  }
  if (!best) return null;
  if (/^true\b/.test(code.slice(best.valueAt, best.valueAt + 5))) return { truthy: true, reason: null };
  const literal = strings.find((s) => s.start === best.valueAt + 1);
  return literal && literal.end > literal.start ? { truthy: true, reason: src.slice(literal.start, literal.end) } : null;
}

const TRUE_VALUE = /true\s*[,}]/y;

export function jsSkipMarkers(src, code, strings, codeAndStrings) {
  const markers = [];
  const callees = [...testCallees(codeAndStrings)].map((name) => name.replace(/\$/g, "\\$")).join("|");
  const calleePattern = new RegExp(String.raw`^(?:[\w$]+\.)?(?:${callees})$`);
  const inString = (at) => strings.some((s) => at >= s.start && at < s.end);
  const holder = String.raw`(?:\s*\.\s*(?:test|it|describe|suite)|\s*\[\s*(["'\x60])(?:test|it|describe|suite)\1\s*\])?`;
  const methods = new RegExp(String.raw`(?<![\w$.])(?:${callees})${holder}(?:\s*\.\s*(only|skip|todo)|\s*\[\s*(["'\x60])(only|skip|todo)\3\s*\])(\s*\()?`, "g");
  for (const match of codeAndStrings.matchAll(methods)) {
    if (inString(match.index)) continue;
    const kind = match[2] ?? match[4];
    if (kind !== "only" && !match[5]) continue;
    markers.push({ at: match.index, kind, reason: null, never: kind === "only" });
  }
  for (const [name, kind] of nodeTestShorthands(codeAndStrings)) {
    for (const match of code.matchAll(new RegExp(String.raw`(?<![\w$.])${name.replace(/\$/g, "\\$")}\s*\(`, "g"))) {
      markers.push({ at: match.index, kind, reason: null, never: kind === "only" });
    }
  }
  const passedToTest = passedToTestCall(code, callees);
  for (const match of codeAndStrings.matchAll(/(?<![\w$.])(["']?)(skip|todo|only)\1\s*:\s*/g)) {
    if (inString(match.index)) continue;
    const valueAt = match.index + match[0].length;
    if (!calleePattern.test(optionBagCallee(code, match.index)) && !passedToTest(boundObjectName(code, match.index))) continue;
    const kind = match[2];
    TRUE_VALUE.lastIndex = valueAt;
    const isTrue = TRUE_VALUE.test(code);
    if (kind === "only") {
      if (isTrue) markers.push({ at: match.index, kind, reason: null, never: true });
      continue;
    }
    if (isTrue) {
      markers.push({ at: match.index, kind, reason: null });
      continue;
    }
    const literal = strings.find((s) => s.start === valueAt + 1);
    if (literal && /^\s*[,}]/.test(code.slice(literal.end + 1, literal.end + 20)) && literal.end > literal.start) {
      markers.push({ at: match.index, kind, reason: src.slice(literal.start, literal.end) });
      continue;
    }
    const named = /^([A-Za-z_$][\w$]*)\s*[,}]/.exec(code.slice(valueAt, valueAt + 80));
    const reason = named && named[1] !== "undefined" && named[1] !== "false" ? constantValue(code, codeAndStrings, strings, src, named[1], match.index)?.reason : null;
    if (reason) markers.push({ at: match.index, kind, reason });
  }
  for (const match of code.matchAll(/(?<=[{,]\s*)(skip|todo|only)(?=\s*[,}])/g)) {
    if (!calleePattern.test(optionBagCallee(code, match.index)) && !passedToTest(boundObjectName(code, match.index))) continue;
    const value = constantValue(code, codeAndStrings, strings, src, match[1], match.index);
    if (!value?.truthy) continue;
    markers.push({ at: match.index, kind: match[1], reason: value.reason, never: match[1] === "only" });
  }
  return markers;
}

export function pythonSkipMarkers(src, code, strings) {
  const markers = [];
  for (const match of code.matchAll(/@(?:unittest\.)?(skip|expectedFailure)\b(\s*\()?|@pytest\.mark\.(skip|xfail)\b(\s*\()?/g)) {
    const kind = match[1] ?? match[3];
    const open = match[2] ?? match[4];
    if (!open) {
      markers.push({ at: match.index, kind, reason: null });
      continue;
    }
    const argsAt = match.index + match[0].length;
    const close = balanced(code, argsAt - 1, "(", ")");
    const args = code.slice(argsAt, close);
    if (kind === "xfail" && !/^\s*(?:$|reason\s*=|(?:condition\s*=\s*)?True\s*(?:[,)]|$))/.test(args)) continue;
    markers.push({ at: match.index, kind, reason: stringAfter(strings, src, argsAt - 1, close) });
  }
  return markers;
}

export function swiftSkipMarkers(src, code, strings) {
  const markers = [];
  for (const match of code.matchAll(/@(?:Test|Suite)\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = balanced(code, open, "(", ")");
    const args = code.slice(open, close);
    for (const disabled of args.matchAll(/\.disabled\s*\(/g)) {
      const at = open + disabled.index + disabled[0].length;
      if (/^\s*if\s*:/.test(code.slice(at, at + 20))) continue;
      markers.push({ at: open + disabled.index, kind: "disabled", reason: stringAfter(strings, src, at - 1, balanced(code, at - 1, "(", ")")) });
    }
  }
  return markers;
}

export function annotationSkipMarkers(src, code, strings, lang) {
  const pattern = lang === "rust" ? /#\[ignore\b(\s*=)?/g : /@(?:Ignore|Disabled)\b(\s*\()?/g;
  return [...code.matchAll(pattern)].map((match) => {
    const end = match.index + match[0].length;
    return { at: match.index, kind: "ignore", reason: match[1] ? stringAfter(strings, src, end - 1, end + 4) : null };
  });
}

export function listMarkers(path, src) {
  let data;
  try {
    data = JSON.parse(src);
  } catch {
    return [];
  }
  const failing = data && typeof data === "object" ? data.failing : undefined;
  const entries = !path.endsWith("scripts/sim/known.json") || failing === undefined ? [] : Array.isArray(failing) ? failing : [failing];
  const failingAt = Math.max(0, src.search(/"failing"\s*:/));
  let cursor = failingAt;
  return entries.map((raw) => {
    const entry = raw && typeof raw === "object" ? raw : {};
    const issue = entry.issue === undefined ? null : new RegExp(String.raw`"issue"\s*:\s*${Number(entry.issue)}\b`, "g");
    let at = cursor;
    if (issue) {
      issue.lastIndex = cursor;
      const found = issue.exec(src);
      if (found) at = found.index;
    }
    cursor = at + 1;
    const owner = typeof entry.owner === "string" && OWNER.test(entry.owner) ? entry.owner.slice(1) : null;
    const supplied = Object.hasOwn(entry, "expires");
    return { at, kind: "quarantine", owner, date: typeof entry.expires === "string" ? entry.expires : null, claimed: supplied ? String(entry.expires) : null };
  });
}

export const ACCEPTED_RISK_LISTS = ["apps/browser/scripts/sim/known.json"];

function isCalendarDate(date) {
  if (!EXPIRY_DATE.test(date ?? "")) return false;
  const time = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(date);
}

const CLAIMED_EXPIRY = /@[A-Za-z0-9-]+\s+until\s+(\S+?)(?=:|\s|$)/;

export function resolveMarker(src, marker) {
  const line = lineOf(src, marker.at);
  if (marker.never) return { ...marker, line, owner: null, date: null };
  const fromReason = marker.date === undefined;
  const mark = fromReason && marker.reason ? EXPIRY_MARK.exec(marker.reason) : null;
  const owner = fromReason ? (mark?.[1] ?? null) : marker.owner;
  const date = fromReason ? (mark?.[2] ?? null) : marker.date;
  if (isCalendarDate(date) && owner) return { ...marker, line, owner, date };
  const claimed = fromReason ? (marker.reason ? (CLAIMED_EXPIRY.exec(marker.reason)?.[1] ?? null) : null) : marker.claimed;
  const invalid = claimed === null || isCalendarDate(claimed) ? null : claimed === "" ? '""' : claimed;
  return { ...marker, line, owner: null, date: null, invalid };
}
