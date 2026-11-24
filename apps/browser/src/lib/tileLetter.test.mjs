import assert from "node:assert/strict";
import { test } from "node:test";
const { tileLetterOf } = await import("./tileLetter.ts");

test("a pinned tile's letter is its site name's first letter, without subdomains or the suffix", () => {
  assert.equal(tileLetterOf("https://www.figma.com/files", "Figma"), "F");
  assert.equal(tileLetterOf("https://news.ycombinator.com/", "Hacker News"), "Y");
  assert.equal(tileLetterOf("https://mail.google.com/mail/u/0/", "Inbox"), "G");
  assert.equal(tileLetterOf("https://www.bbc.co.uk/news", "BBC"), "B");
  assert.equal(tileLetterOf("https://en.wikipedia.org/wiki/Web_browser", "Web browser"), "W");
  assert.equal(tileLetterOf("https://x.com/home", "Home / X"), "X");
});

test("an address with no letters, or none at all, takes the title's first letter", () => {
  assert.equal(tileLetterOf("http://127.0.0.1:8080/notes", "  — notes"), "N");
  assert.equal(tileLetterOf("", "Écrire"), "É");
  assert.equal(tileLetterOf("", ""), "•");
});
