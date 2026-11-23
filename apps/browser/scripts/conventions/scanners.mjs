const SHELL_WORD_BREAK = /[\s;&|()<>`]/;
const POWERSHELL_WORD_BREAK = /[\s;|({}]/;

const lineEndAt = (src, at) => {
  const end = src.indexOf("\n", at);
  return end < 0 ? src.length : end;
};

function skipShebang(src) {
  return src.startsWith("#!") ? lineEndAt(src, 0) : 0;
}

export function scanShell(src) {
  const n = src.length;
  const comments = [];
  const strings = [];
  const heredocs = [];
  let i = skipShebang(src);

  const heredocBodies = () => {
    let at = i + 1;
    let resume = i;
    for (const { word, tabs } of heredocs.splice(0)) {
      const bodyStart = at;
      let terminator = -1;
      while (at < n) {
        const end = lineEndAt(src, at);
        const line = src.slice(at, end).replace(/\r$/, "");
        if ((tabs ? line.replace(/^\t+/, "") : line) === word) {
          terminator = end;
          break;
        }
        at = end + 1;
      }
      if (terminator < 0) break;
      strings.push({ start: bodyStart, end: at, kind: "heredoc" });
      resume = terminator;
      at = terminator + 1;
    }
    i = resume;
  };
  const single = () => {
    const start = ++i;
    while (i < n && src[i] !== "'") i++;
    strings.push({ start, end: Math.min(i, n), kind: "single" });
    i++;
  };
  const ansi = () => {
    i += 2;
    const start = i;
    while (i < n && src[i] !== "'") i += src[i] === "\\" ? 2 : 1;
    strings.push({ start, end: Math.min(i, n), kind: "single" });
    i++;
  };
  const backtick = () => {
    i++;
    code("`");
    i++;
  };
  const arithmetic = () => {
    let depth = 0;
    while (i < n) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) {
        i++;
        return;
      }
      i++;
    }
  };
  const double = () => {
    let start = ++i;
    while (i < n && src[i] !== '"') {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "$" && src[i + 1] === "(") {
        strings.push({ start, end: i, kind: "double" });
        if (src[i + 2] === "(") {
          i++;
          arithmetic();
        } else {
          i += 2;
          code(")");
          i++;
        }
        start = i;
      } else if (src[i] === "`") {
        strings.push({ start, end: i, kind: "double" });
        backtick();
        start = i;
      } else i++;
    }
    strings.push({ start, end: Math.min(i, n), kind: "double" });
    i++;
  };
  const parameter = () => {
    i += 2;
    let depth = 1;
    while (i < n && depth) {
      if (src[i] === "\\") {
        i += 2;
        continue;
      }
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
  };
  const heredoc = () => {
    const match = /^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([\w][\w.-]*))/.exec(src.slice(i, i + 120));
    if (!match) return false;
    heredocs.push({ word: match[2] ?? match[3] ?? match[4], tabs: match[1] === "-" });
    i += match[0].length;
    return true;
  };
  const code = (closer) => {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (closer === "`" && c === "`") return;
      if (c === "\n") {
        if (heredocs.length) heredocBodies();
        i++;
        continue;
      }
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "#" && (i === 0 || SHELL_WORD_BREAK.test(src[i - 1]))) {
        const start = i;
        i = lineEndAt(src, i);
        comments.push([start, i]);
        continue;
      }
      if (c === "'") {
        single();
        continue;
      }
      if (c === '"') {
        double();
        continue;
      }
      if (c === "`") {
        backtick();
        continue;
      }
      if (c === "$") {
        const next = src[i + 1];
        if (next === "'") ansi();
        else if (next === "(" && src[i + 2] === "(") {
          i++;
          arithmetic();
        } else if (next === "(") {
          i += 2;
          code(")");
          i++;
        } else if (next === "{") parameter();
        else i += 2;
        continue;
      }
      if (c === "(" && src[i + 1] === "(" && (i === 0 || SHELL_WORD_BREAK.test(src[i - 1]))) {
        arithmetic();
        continue;
      }
      if (src.startsWith("<<<", i)) {
        i += 3;
        continue;
      }
      if (c === "<" && src[i + 1] === "<" && heredoc()) continue;
      if (closer && depth === 0 && c === closer) return;
      if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
  };
  code(null);
  return { comments, strings };
}

export function scanPowerShell(src) {
  const n = src.length;
  const comments = [];
  const strings = [];
  const help = [];
  let i = skipShebang(src);

  const hereString = (quote) => {
    const close = `\n${quote}@`;
    const start = i + 2;
    const end = src.indexOf(close, start);
    const stop = end < 0 ? n : end + 1;
    strings.push({ start, end: stop });
    i = stop + 2;
  };
  const single = () => {
    const start = ++i;
    while (i < n) {
      if (src[i] === "'" && src[i + 1] === "'") i += 2;
      else if (src[i] === "'") break;
      else i++;
    }
    strings.push({ start, end: Math.min(i, n) });
    i++;
  };
  const double = () => {
    const start = ++i;
    while (i < n) {
      if (src[i] === "`") i += 2;
      else if (src[i] === '"' && src[i + 1] === '"') i += 2;
      else if (src[i] === '"') break;
      else if (src[i] === "$" && src[i + 1] === "(") {
        i += 2;
        code(")");
        i++;
      } else i++;
    }
    strings.push({ start, end: Math.min(i, n) });
    i++;
  };
  const code = (closer) => {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === "<" && src[i + 1] === "#") {
        const start = i;
        const end = src.indexOf("#>", i + 2);
        i = end < 0 ? n : end + 2;
        comments.push([start, i]);
        if (/^\s*\.(?:SYNOPSIS|DESCRIPTION)\b/im.test(src.slice(start, i))) help.push([start, i]);
        continue;
      }
      if (c === "#" && (i === 0 || POWERSHELL_WORD_BREAK.test(src[i - 1]))) {
        const start = i;
        i = lineEndAt(src, i);
        comments.push([start, i]);
        continue;
      }
      if (c === "@" && (src[i + 1] === '"' || src[i + 1] === "'") && /^[ \t]*\r?\n/.test(src.slice(i + 2, i + 8))) {
        hereString(src[i + 1]);
        continue;
      }
      if (c === "`") {
        i += 2;
        continue;
      }
      if (c === "'") {
        single();
        continue;
      }
      if (c === '"') {
        double();
        continue;
      }
      if (closer && depth === 0 && c === closer) return;
      if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
  };
  code(null);
  return { comments, strings, help };
}

const PY_STRING_START = /^([rRbBuUfF]{0,2})('''|"""|'|")/;

export function scanPython(src) {
  const n = src.length;
  const comments = [];
  const strings = [];
  const docstrings = [];
  let i = skipShebang(src);
  let depth = 0;
  let statementStart = true;
  let continued = false;

  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      if (depth === 0 && !continued) statementStart = true;
      continued = false;
      i++;
      continue;
    }
    if (c === "\\" && src[i + 1] === "\n") {
      continued = true;
      i++;
      continue;
    }
    if (c === "#") {
      const start = i;
      i = lineEndAt(src, i);
      comments.push([start, i]);
      continue;
    }
    if (/[ \t\r\f]/.test(c)) {
      i++;
      continue;
    }
    const opener = /[\w'"]/.test(c) && !/[\w]/.test(src[i - 1] ?? "") ? PY_STRING_START.exec(src.slice(i, i + 5)) : null;
    if (opener) {
      const quote = opener[2];
      const tokenStart = i;
      i += opener[0].length;
      const start = i;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src.startsWith(quote, i)) break;
        if (quote.length === 1 && src[i] === "\n") break;
        i++;
      }
      const end = Math.min(i, n);
      strings.push({ start, end });
      i += src.startsWith(quote, i) ? quote.length : 0;
      if (statementStart && depth === 0) {
        const rest = src.slice(i, lineEndAt(src, i));
        if (/^\s*(?:#.*)?$/.test(rest)) docstrings.push([tokenStart, i]);
      }
      statementStart = false;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      statementStart = true;
      i++;
      continue;
    }
    statementStart = false;
    i++;
  }
  return { comments, strings, docstrings };
}

const RUBY_HEREDOC = /^<<([~-]?)(['"`]?)([A-Za-z_]\w*)\2/;

const SIMPLE_HASH = {
  toml: { quotes: ['"""', "'''", '"', "'"], escapes: { '"': true, '"""': true } },
  gn: { quotes: ['"'], escapes: { '"': true } },
  ruby: { quotes: ['"', "'"], escapes: { '"': true, "'": true }, rubyBlocks: true, regexes: true },
  docker: { quotes: [], escapes: {}, lineStartOnly: true },
};

export function scanHashSimple(src, lang) {
  const { quotes, escapes, lineStartOnly, rubyBlocks, regexes } = SIMPLE_HASH[lang];
  const n = src.length;
  const comments = [];
  const strings = [];
  const heredocs = [];
  let i = skipShebang(src);
  while (i < n) {
    const inHeredoc = heredocs.find((body) => i >= body.start && i < body.end);
    if (inHeredoc) {
      strings.push({ start: inHeredoc.start, end: inHeredoc.end });
      heredocs.splice(heredocs.indexOf(inHeredoc), 1);
      i = inHeredoc.end;
      continue;
    }
    const lineStart = i === 0 || src[i - 1] === "\n";
    if (rubyBlocks && lineStart && src.startsWith("=begin", i)) {
      const start = i;
      const end = src.indexOf("\n=end", i);
      i = end < 0 ? n : lineEndAt(src, end + 1);
      comments.push([start, i]);
      continue;
    }
    const c = src[i];
    if (c === "#") {
      const onlyIndentBefore = /^[ \t]*$/.test(src.slice(src.lastIndexOf("\n", i - 1) + 1, i));
      if (!lineStartOnly || onlyIndentBefore) {
        const start = i;
        i = lineEndAt(src, i);
        comments.push([start, i]);
        continue;
      }
    }
    if (rubyBlocks) {
      const heredoc = RUBY_HEREDOC.exec(src.slice(i, i + 80));
      if (heredoc && (heredoc[1] || heredoc[2] || /^[A-Z_][A-Z0-9_]*$/.test(heredoc[3]))) {
        const word = heredoc[3];
        const squiggly = heredoc[1] !== "";
        let at = lineEndAt(src, i) + 1;
        const bodyStart = at;
        while (at < src.length) {
          const end = lineEndAt(src, at);
          const line = src.slice(at, end);
          if ((squiggly ? line.trim() : line) === word) break;
          at = end + 1;
        }
        heredocs.push({ start: bodyStart, end: Math.min(at, n) });
        i += heredoc[0].length;
        continue;
      }
      const percent = /^%[qQwWiIrs]?([^\w\s])/.exec(src.slice(i, i + 4));
      const typed = /^%[qQwWiIrs]/.test(src.slice(i, i + 2));
      const afterValue = /[\w)\]}]/.test(src.slice(Math.max(0, i - 40), i).trimEnd().slice(-1));
      if (percent && (typed ? !/[\w)\]}]$/.test(src.slice(Math.max(0, i - 1), i)) : !afterValue)) {
        const open = percent[1];
        const close = { "(": ")", "[": "]", "{": "}", "<": ">" }[open] ?? open;
        let depth = 1;
        let at = i + percent[0].length;
        const start = at;
        while (at < n && depth) {
          if (src[at] === "\\") at += 2;
          else {
            if (src[at] === close) depth--;
            else if (src[at] === open && open !== close) depth++;
            at++;
          }
        }
        strings.push({ start, end: Math.max(start, at - 1) });
        i = at;
        continue;
      }
    }
    if (regexes && c === "/" && /(?:^|[(,=~!|&{[;]|\b(?:when|if|unless|and|or|not|return))\s*$/.test(src.slice(Math.max(0, i - 12), i))) {
      const start = ++i;
      while (i < n && src[i] !== "/" && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
      strings.push({ start, end: Math.min(i, n) });
      i++;
      continue;
    }
    const quote = quotes.find((q) => src.startsWith(q, i));
    if (quote) {
      i += quote.length;
      const start = i;
      while (i < n && !src.startsWith(quote, i) && (quote.length === 3 || src[i] !== "\n")) i += escapes[quote] && src[i] === "\\" ? 2 : 1;
      strings.push({ start, end: Math.min(i, n) });
      i += quote.length;
      continue;
    }
    i++;
  }
  return { comments, strings };
}

const YAML_BLOCK = /^(\s*)(-\s+)?(?:([\w.$-]+|"[^"]*"|'[^']*')\s*:\s+)?(?:[&!][^\s]*\s+)*[|>][-+]?\d?[-+]?\s*(?:#.*)?$/;

const indentOf = (text) => text.match(/^\s*/)[0].length;

function defaultsShells(lines) {
  const found = [];
  lines.forEach((line, k) => {
    if (!/^\s*defaults:\s*$/.test(line.text)) return;
    const base = indentOf(line.text);
    let run = -1;
    for (let j = k + 1; j < lines.length; j++) {
      const text = lines[j].text;
      if (!isContent(text)) continue;
      const indent = indentOf(text);
      if (indent <= base) break;
      if (/^\s*run:\s*$/.test(text)) run = indent;
      else if (run >= 0 && indent > run) {
        const shell = /^\s*shell:\s*['"]?(\w+)/.exec(text);
        if (shell) found.push({ at: k, indent: base, shell: shell[1] });
      } else if (indent <= run) run = -1;
    }
  });
  return found;
}

const isContent = (text) => text.trim() !== "" && !/^\s*#/.test(text);

function childIndent(lines, at) {
  for (let k = at + 1; k < lines.length; k++) if (isContent(lines[k].text)) return indentOf(lines[k].text);
  return -1;
}

function jobOf(lines, at) {
  const jobs = lines.findIndex((line) => /^jobs:\s*$/.test(line.text));
  if (jobs < 0 || at <= jobs) return -1;
  const jobIndent = childIndent(lines, jobs);
  for (let k = at; k > jobs; k--) {
    const text = lines[k].text;
    if (text.trim() && indentOf(text) === jobIndent && /^\s*[\w.-]+:\s*$/.test(text)) return k;
  }
  return -1;
}

function defaultsShell(lines, at) {
  const all = defaultsShells(lines);
  const job = jobOf(lines, at);
  const own = all.find((entry) => entry.indent > 0 && job >= 0 && jobOf(lines, entry.at) === job);
  return own?.shell ?? all.find((entry) => entry.indent === 0)?.shell ?? null;
}

function runnerShell(lines, at) {
  const job = jobOf(lines, at);
  if (job < 0) return null;
  const jobIndent = indentOf(lines[job].text);
  const keyIndent = childIndent(lines, job);
  for (let k = job + 1; k < lines.length; k++) {
    const text = lines[k].text;
    if (isContent(text) && indentOf(text) <= jobIndent) break;
    if (indentOf(text) !== keyIndent) continue;
    if (/^\s*runs-on:.*\bwindows\b/i.test(text)) return "pwsh";
    if (/^\s*runs-on:\s*$/.test(text)) {
      for (let j = k + 1; j < lines.length && (!lines[j].text.trim() || indentOf(lines[j].text) > keyIndent || (indentOf(lines[j].text) === keyIndent && /^\s*-\s/.test(lines[j].text))); j++) if (/^\s*-\s*['"]?windows\b/i.test(lines[j].text)) return "pwsh";
    }
  }
  return null;
}

function runShellOf(lines, at, keyIndent) {
  return siblingShell(lines, at, keyIndent) ?? defaultsShell(lines, at) ?? runnerShell(lines, at);
}

function siblingValue(lines, at, keyIndent, key) {
  const pattern = new RegExp(String.raw`^\s*(?:-\s+)?${key}:\s*(.*)$`);
  for (let k = at; k >= 0; k--) {
    const line = lines[k].text;
    if (!line.trim()) continue;
    const indent = indentOf(line);
    const dash = line.match(/^\s*-\s+/)?.[0].length;
    if (k < at && indent < keyIndent && dash === undefined) break;
    const found = pattern.exec(line);
    if (found && (indent === keyIndent || dash === keyIndent)) return found[1];
    if (dash === keyIndent) break;
  }
  for (let k = at + 1; k < lines.length; k++) {
    const line = lines[k].text;
    if (!line.trim()) continue;
    const indent = indentOf(line);
    if (indent < keyIndent || (indent === keyIndent && /^\s*-\s/.test(line))) break;
    const found = pattern.exec(line);
    if (found && indent === keyIndent) return found[1];
  }
  return null;
}

function siblingShell(lines, at, keyIndent) {
  return /^['"]?(\w+)/.exec(siblingValue(lines, at, keyIndent, "shell") ?? "")?.[1] ?? null;
}

function isStepKey(lines, at, keyIndent) {
  let dashAt = -1;
  let dashIndent = -1;
  const own = /^(\s*)-\s+/.exec(lines[at].text);
  if (own && own[0].length === keyIndent) {
    dashAt = at;
    dashIndent = own[1].length;
  } else {
    for (let k = at - 1; k >= 0; k--) {
      const text = lines[k].text;
      if (!text.trim() || indentOf(text) > keyIndent) continue;
      const dash = /^(\s*)-\s+/.exec(text);
      if (dash && dash[0].length === keyIndent) {
        dashAt = k;
        dashIndent = dash[1].length;
        break;
      }
      if (indentOf(text) < keyIndent) return false;
    }
  }
  if (dashAt < 0) return false;
  for (let k = dashAt - 1; k >= 0; k--) {
    const text = lines[k].text;
    if (!text.trim() || indentOf(text) > dashIndent || (indentOf(text) === dashIndent && /^\s*-\s/.test(text))) continue;
    return /^\s*steps:\s*$/.test(text);
  }
  return false;
}

function runsGithubScript(lines, at, keyIndent) {
  for (let k = at - 1; k >= 0; k--) {
    const text = lines[k].text;
    if (!text.trim() || indentOf(text) >= keyIndent) continue;
    const parent = /^(\s*)(-\s+)?with:\s*$/.exec(text);
    if (!parent) return false;
    return /^['"]?actions\/github-script@/.test(siblingValue(lines, k, parent[1].length + (parent[2]?.length ?? 0), "uses") ?? "");
  }
  return false;
}

const SHELL_LANGS = { pwsh: "powershell", powershell: "powershell", python: "python", bash: "shell", sh: "shell" };
const SCALAR_PROPERTIES = String.raw`(?:[&!][^\s]*\s+)*`;

export function scanYaml(src, { executable = true } = {}) {
  const comments = [];
  const strings = [];
  const embedded = [];
  const lines = [];
  for (let at = 0; at <= src.length; ) {
    const end = lineEndAt(src, at);
    lines.push({ start: at, text: src.slice(at, end) });
    at = end + 1;
  }
  let quote = null;
  let quoteStart = 0;
  for (let k = 0; k < lines.length; k++) {
    const { start, text } = lines[k];
    if (!quote) {
      const block = YAML_BLOCK.exec(text);
      if (block) {
        const keyIndent = block[1].length + (block[2]?.length ?? 0);
        const key = block[3]?.replace(/^['"]|['"]$/g, "");
        const hash = text.search(/\s#/);
        if (hash >= 0) comments.push([start + hash + 1, start + text.length]);
        let last = k;
        let indent = Infinity;
        for (let j = k + 1; j < lines.length; j++) {
          const body = lines[j].text;
          if (!body.trim()) continue;
          const bodyIndent = body.match(/^\s*/)[0].length;
          if (bodyIndent <= keyIndent - (block[2] && !block[3] ? 2 : 0)) break;
          indent = Math.min(indent, bodyIndent);
          last = j;
        }
        if (last > k) {
          const bodyLines = lines.slice(k + 1, last + 1);
          const lang = !executable ? null : key === "run" && isStepKey(lines, k, keyIndent) ? (SHELL_LANGS[runShellOf(lines, k, keyIndent)] ?? "shell") : key === "script" && runsGithubScript(lines, k, keyIndent) ? "js" : null;
          if (lang) {
            const offsets = bodyLines.map((line) => line.start + Math.min(indent, line.text.length));
            const pieces = bodyLines.map((line) => line.text.slice(indent));
            const folded = /(?::|^\s*-)\s+(?:[&!]\S*\s+)*>/.test(text.replace(/\s+#.*$/, ""));
            const joins = pieces.map((piece, at) => (at === 0 ? "" : folded && piece && pieces[at - 1] && !/^\s/.test(piece) && !/^\s/.test(pieces[at - 1]) ? " " : "\n"));
            const charMap = [];
            let joined = "";
            pieces.forEach((piece, at) => {
              if (at > 0) {
                charMap.push(offsets[at] - 1);
                joined += joins[at];
              }
              for (let c = 0; c < piece.length; c++) charMap.push(offsets[at] + c);
              joined += piece;
            });
            embedded.push({ lang, text: joined, offsets, charMap });
          }
          strings.push({ start: lines[k + 1].start, end: lines[last].start + lines[last].text.length });
          k = last;
        }
        continue;
      }
    }
    let commentAt = text.length;
    for (let c = 0; c < text.length; c++) {
      const ch = text[c];
      if (quote === "'") {
        if (ch === "'" && text[c + 1] === "'") c++;
        else if (ch === "'") {
          strings.push({ start: quoteStart, end: start + c });
          quote = null;
        }
        continue;
      }
      if (quote === '"') {
        if (ch === "\\") c++;
        else if (ch === '"') {
          strings.push({ start: quoteStart, end: start + c });
          quote = null;
        }
        continue;
      }
      if (ch === "#" && (c === 0 || /\s/.test(text[c - 1]))) {
        comments.push([start + c, start + text.length]);
        commentAt = c;
        break;
      }
      if ((ch === "'" || ch === '"') && /(?:^\s*|[:?-]\s+|[[{,]\s*)(?:[&!]\S*\s+)*$/.test(text.slice(0, c))) {
        quote = ch;
        quoteStart = start + c + 1;
      }
    }
    const inline = new RegExp(String.raw`^(\s*)(-\s+)?(run|script):[ \t]+${SCALAR_PROPERTIES}(?=[^\s|>])`).exec(text);
    const inlineIndent = inline ? inline[1].length + (inline[2]?.length ?? 0) : 0;
    if (inline && !quote && executable && (inline[3] === "run" ? isStepKey(lines, k, inlineIndent) : runsGithubScript(lines, k, inlineIndent))) {
      const keyIndent = inline[1].length + (inline[2]?.length ?? 0);
      let from = inline[0].length;
      let value = text.slice(from, commentAt).replace(/\s+$/, "");
      const quoted = /^(["'])(.*)\1$/.exec(value);
      if (quoted) {
        from++;
        value =
          quoted[1] === '"'
            ? quoted[2].replace(/\\(.)/g, (_, ch) => (ch === "n" ? " \n" : ch === "t" ? "  " : ` ${ch}`))
            : quoted[2].replace(/''/g, " '");
      }
      const lang = inline[3] === "script" ? "js" : (SHELL_LANGS[runShellOf(lines, k, keyIndent)] ?? "shell");
      const charMap = Array.from({ length: value.length }, (_, at) => start + from + at);
      if (value) embedded.push({ lang, text: value, offsets: [start + from], charMap });
    }
  }
  return { comments, strings, embedded };
}

export function embeddedToSource({ text, offsets, charMap }, at) {
  if (charMap) return at < charMap.length ? charMap[at] : (charMap.at(-1) ?? offsets[0]) + 1;
  let line = 0;
  let lineStart = 0;
  for (let k = 0; k < at && k < text.length; k++) {
    if (text[k] === "\n") {
      line++;
      lineStart = k + 1;
    }
  }
  return offsets[line] + (at - lineStart);
}

const MARKUP_COMMENT_OR_BLOCK = /<!--[\s\S]*?(?:-->|$)|<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
const NON_JS_SCRIPT = /(?:^|\s)type\s*=\s*["']?(?!module|text\/javascript|application\/javascript)[\w/+.-]+/i;

export function scanMarkup(src, lang) {
  const comments = [];
  const strings = [];
  const embedded = [];
  let body = src;
  if (lang === "astro") {
    const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(src);
    if (front) {
      embedded.push({ lang: "js", text: front[1], offsets: lineOffsets(src, 4, front[1]) });
      body = " ".repeat(front[0].length) + src.slice(front[0].length);
    }
  }
  if (lang !== "xml") {
    let rest = "";
    let at = 0;
    for (const match of body.matchAll(MARKUP_COMMENT_OR_BLOCK)) {
      if (!match[1]) continue;
      const contentStart = match.index + match[0].indexOf(">") + 1;
      const content = match[3];
      rest += body.slice(at, contentStart) + content.replace(/[^\n]/g, " ");
      at = contentStart + content.length;
      const isStyle = match[1].toLowerCase() === "style";
      if (isStyle || !NON_JS_SCRIPT.test(match[2])) embedded.push({ lang: isStyle ? "css" : "js", text: content, offsets: lineOffsets(src, contentStart, content) });
      strings.push({ start: contentStart, end: contentStart + content.length });
    }
    body = rest + body.slice(at);
    if (lang === "astro") {
      for (const match of body.matchAll(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g)) comments.push([match.index, match.index + match[0].length]);
    }
  }
  for (const match of body.matchAll(/<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g)) {
    if (match[0].startsWith("<!--")) comments.push([match.index, match.index + match[0].length]);
    else strings.push({ start: match.index, end: match.index + match[0].length });
  }
  return { comments, strings, embedded };
}

function lineOffsets(src, start, text) {
  const offsets = [start];
  for (let k = 0; k < text.length; k++) if (text[k] === "\n") offsets.push(start + k + 1);
  return offsets;
}
