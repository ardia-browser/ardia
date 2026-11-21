import assert from "node:assert/strict";
import { test } from "node:test";
const { parseMarkdown, parseInline, markdownLink } = await import("./pluginMarkdown.ts");

test("headings, rules and paragraphs split into blocks", () => {
  const blocks = parseMarkdown("# Title\n## Sub ##\n#### Deep\n\nOne line\nsame paragraph\n\n---\n***\nAfter");
  assert.deepEqual(blocks, [
    { kind: "heading", level: 1, spans: [{ text: "Title" }] },
    { kind: "heading", level: 2, spans: [{ text: "Sub" }] },
    { kind: "heading", level: 3, spans: [{ text: "Deep" }] },
    { kind: "paragraph", spans: [{ text: "One line same paragraph" }] },
    { kind: "rule" },
    { kind: "rule" },
    { kind: "paragraph", spans: [{ text: "After" }] },
  ]);
});

test("a fenced code block keeps its lines verbatim, markup included", () => {
  const blocks = parseMarkdown("```ts\nconst a = **1**;\n\n# not a heading\n```\ntext\n~~~\nopen to the end");
  assert.deepEqual(blocks, [
    { kind: "code", text: "const a = **1**;\n\n# not a heading", language: "ts" },
    { kind: "paragraph", spans: [{ text: "text" }] },
    { kind: "code", text: "open to the end", language: undefined },
  ]);
});

test("bullet and ordered lists group their items, with depth and continuation lines", () => {
  const blocks = parseMarkdown("- one\n* two\n  - nested\n  wrapped\n\n3. three\n4) four");
  assert.deepEqual(blocks, [
    {
      kind: "list",
      ordered: false,
      items: [
        { marker: "•", depth: 0, spans: [{ text: "one" }] },
        { marker: "•", depth: 0, spans: [{ text: "two" }] },
        { marker: "•", depth: 1, spans: [{ text: "nested wrapped" }] },
      ],
    },
    {
      kind: "list",
      ordered: true,
      items: [
        { marker: "3.", depth: 0, spans: [{ text: "three" }] },
        { marker: "4.", depth: 0, spans: [{ text: "four" }] },
      ],
    },
  ]);
});

test("a blockquote parses its own blocks", () => {
  assert.deepEqual(parseMarkdown("> # Note\n> first\n>second\nplain"), [
    { kind: "quote", blocks: [{ kind: "heading", level: 1, spans: [{ text: "Note" }] }, { kind: "paragraph", spans: [{ text: "first second" }] }] },
    { kind: "paragraph", spans: [{ text: "plain" }] },
  ]);
  assert.deepEqual(parseMarkdown("> quoted\n\nplain"), [
    { kind: "quote", blocks: [{ kind: "paragraph", spans: [{ text: "quoted" }] }] },
    { kind: "paragraph", spans: [{ text: "plain" }] },
  ]);
});

test("inline bold, italic, code and escapes become styled spans", () => {
  assert.deepEqual(parseInline("a **bold *both*** and *it* `x*y*` \\*lit\\*"), [
    { text: "a " },
    { text: "bold ", bold: true },
    { text: "both", bold: true, italic: true },
    { text: " and " },
    { text: "it", italic: true },
    { text: " " },
    { text: "x*y*", code: true },
    { text: " *lit*" },
  ]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ text: "2 * 3 * 4" }]);
});

test("only http and https links carry a URL; others fall back to their text", () => {
  assert.deepEqual(parseInline("see [the **docs**](https://example.com/a?b=1 \"Title\") now"), [
    { text: "see " },
    { text: "the ", url: "https://example.com/a?b=1" },
    { text: "docs", bold: true, url: "https://example.com/a?b=1" },
    { text: " now" },
  ]);
  for (const href of ["javascript:alert(1)", "file:///etc/passwd", "ardia://settings", "https://user:pw@example.com/", "/relative"]) {
    assert.deepEqual(parseInline(`[x](${href})`), [{ text: "x" }], href);
  }
});

test("Windows line endings and empty input parse cleanly", () => {
  assert.deepEqual(parseMarkdown("# A\r\n\r\nB\r\n"), [
    { kind: "heading", level: 1, spans: [{ text: "A" }] },
    { kind: "paragraph", spans: [{ text: "B" }] },
  ]);
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("#"), [{ kind: "heading", level: 1, spans: [] }]);
});

test("blockquotes stop nesting past the depth cap", () => {
  let blocks = parseMarkdown(`${">".repeat(5000)} deep`);
  let depth = 0;
  while (blocks[0]?.kind === "quote") {
    blocks = blocks[0].blocks;
    depth++;
  }
  assert.equal(depth, 4);
  assert.equal(blocks[0].kind, "paragraph");
});

const REGEX_INLINE = /\\([\\`*_[\]()#>!+.-])|`([^`]+)`|\[([^\]]+)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)|\*\*(.+?)\*\*(?!\*)|__(.+?)__(?!_)|\*([^*\s](?:[^*]*[^*\s])?)\*/;

function regexInline(source, style = {}) {
  const spans = [];
  const push = (text, extra = {}) => {
    if (!text) return;
    const next = { text };
    if (extra.bold ?? style.bold) next.bold = true;
    if (extra.italic ?? style.italic) next.italic = true;
    if (extra.code ?? style.code) next.code = true;
    const url = extra.url ?? style.url;
    if (url) next.url = url;
    const last = spans[spans.length - 1];
    if (last && last.bold === next.bold && last.italic === next.italic && last.code === next.code && last.url === next.url) last.text += text;
    else spans.push(next);
  };
  let rest = source;
  while (rest) {
    const found = REGEX_INLINE.exec(rest);
    if (!found) {
      push(rest);
      break;
    }
    push(rest.slice(0, found.index));
    const [whole, escaped, code, label, href, strong, strongAlt, emphasis] = found;
    if (escaped !== undefined) push(escaped);
    else if (code !== undefined) push(code, { code: true });
    else if (label !== undefined) {
      const url = style.url ?? markdownLink(href);
      for (const span of regexInline(label, { ...style, url })) push(span.text, span);
    } else if (strong !== undefined || strongAlt !== undefined) {
      for (const span of regexInline(strong ?? strongAlt, { ...style, bold: true })) push(span.text, span);
    } else if (emphasis !== undefined) {
      for (const span of regexInline(emphasis, { ...style, italic: true })) push(span.text, span);
    }
    rest = rest.slice(found.index + whole.length);
  }
  return spans;
}

test("the linear inline scanner gives the same spans as the old one-regex parser on random markup", () => {
  const pieces = ["*", "**", "_", "__", "`", "[", "]", "(", ")", "](", "<", ">", "\\", '"', " ", "a", "b", "\n", "\t", "https://x.example/p", "(q)", "#", "!", "-"];
  let seed = 7;
  const random = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (let round = 0; round < 6000; round++) {
    let text = "";
    for (let i = random(24); i >= 0; i--) text += pieces[random(pieces.length)];
    assert.deepEqual(parseInline(text), regexInline(text), JSON.stringify(text));
  }
});

test("markup that never closes is scanned in linear time, so a 256 KB plugin tree can't freeze a render", () => {
  const shapes = {
    brackets: "[".repeat(128000),
    bracketsThenUnclosedTail: `${"[".repeat(64000)}](${"x".repeat(64000)}`,
    bracketsThenLongTitle: `${"[".repeat(64000)}](x "${"t".repeat(64000)}`,
    nestedBrackets: "[[a]".repeat(32000),
    stars: "*".repeat(128000),
    strongOpeners: "**a ".repeat(32000),
    underscores: "__a\n".repeat(32000),
    emphasisSpaced: "*a ".repeat(42000),
    ticks: "`a".repeat(64000),
    escapes: "\\[".repeat(64000),
    strongInsideStrong: "**".repeat(64000),
    alternatingStrong: "**__".repeat(32000) + "x" + "__**".repeat(32000),
  };
  for (const [name, text] of Object.entries(shapes)) {
    const started = performance.now();
    const spans = parseInline(text);
    const took = performance.now() - started;
    assert.ok(spans.length > 0, name);
    assert.ok(took < 400, `${name} took ${Math.round(took)} ms`);
  }
  assert.deepEqual(parseInline(`${"**".repeat(40)}x${"**".repeat(40)}`), [{ text: "*".repeat(12), bold: true }, { text: "x" }, { text: "*".repeat(12), bold: true }], "markup nested past 16 levels shows as styled text instead of going deeper");
});
