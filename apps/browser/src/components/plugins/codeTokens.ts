export type CodeTone = "keyword" | "string" | "number" | "comment" | "punctuation" | "plain";
export type CodeToken = { text: string; tone: CodeTone };

const KEYWORDS = new Set(
  "abstract as async await break case catch class const continue def default defer del do elif else enum export extends false final finally fn for from func function go if impl import in interface is let match mod mut new nil none null of package pass private protected pub public raise return self static struct super switch this throw throws trait true try type typeof undefined use var void where while with yield".split(" "),
);
const HASH_COMMENTS = new Set(["python", "py", "ruby", "rb", "sh", "bash", "zsh", "shell", "yaml", "yml", "toml", "r", "perl"]);
const TOKEN = /("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_.xXa-fA-F]*\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\sA-Za-z_$\d"'`]+)|([\s\S])/gu;

export function codeTokens(line: string, language: string): CodeToken[] {
  const lang = language.toLowerCase();
  const marker = HASH_COMMENTS.has(lang) ? "#" : lang === "sql" || lang === "lua" ? "--" : "//";
  let code = line;
  let comment = "";
  const at = commentStart(line, marker);
  if (at >= 0) {
    code = line.slice(0, at);
    comment = line.slice(at);
  }
  const out: CodeToken[] = [];
  for (const found of code.matchAll(TOKEN)) {
    const [text, str, num, word] = found;
    const tone: CodeTone = str ? "string" : num ? "number" : word ? (KEYWORDS.has(word) ? "keyword" : "plain") : found[5] ? "punctuation" : "plain";
    const last = out[out.length - 1];
    if (last && last.tone === tone && tone !== "keyword") last.text += text;
    else out.push({ text, tone });
  }
  if (comment) out.push({ text: comment, tone: "comment" });
  return out;
}

function commentStart(line: string, marker: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (line.startsWith(marker, i)) return i;
  }
  return -1;
}
