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

test("custom tile letters keep at most two visible characters, upper-cased, and nothing else", async () => {
  const { cleanTileLetters, tileLettersOf } = await import("./tileLetter.ts");
  assert.equal(cleanTileLetters("gm"), "GM");
  assert.equal(cleanTileLetters("  x "), "X");
  assert.equal(cleanTileLetters("abc"), "AB");
  assert.equal(cleanTileLetters("é1"), "É1");
  assert.equal(cleanTileLetters("🚀"), "🚀");
  assert.equal(cleanTileLetters("a\nb"), "AB");
  assert.equal(cleanTileLetters(""), null);
  assert.equal(cleanTileLetters("   "), null);
  assert.equal(cleanTileLetters(42), null);
  assert.equal(tileLettersOf({ url: "https://mail.google.com/", title: "Inbox" }), "G");
  assert.equal(tileLettersOf({ url: "https://mail.google.com/", title: "Inbox", tileLetters: "GM" }), "GM");
});

test("tile letters count what you see: a letter that upper-cases to two counts as two, an emoji sequence or an accented letter counts as one, and cleaning twice changes nothing", async () => {
  const { cleanTileLetters } = await import("./tileLetter.ts");
  assert.equal(cleanTileLetters("aß"), "AS", "ß upper-cases to SS before the limit");
  assert.equal(cleanTileLetters("👩‍💻"), "👩‍💻", "a ZWJ sequence is one");
  assert.equal(cleanTileLetters("👩‍💻x"), "👩‍💻X");
  assert.equal(cleanTileLetters("👍🏽a"), "👍🏽A", "a skin tone stays with its emoji");
  assert.equal(cleanTileLetters("🇫🇷🇩🇪x"), "🇫🇷🇩🇪", "a flag is one");
  assert.equal(cleanTileLetters("éx"), "ÉX", "a combining accent joins its letter");
  assert.equal(cleanTileLetters("q̣̇z"), "Q̣̇Z".normalize("NFC"));
  assert.equal(cleanTileLetters("́a"), "A", "a mark with nothing before it goes");
  assert.equal(cleanTileLetters("a‮b"), "AB", "a direction override goes");
  const samples = ["aß", "ß", "👩‍💻", "👩‍💻👩‍💻x", "🇫🇷🇩🇪", "é", "ǆ", "ﬃ", "İi", "ŉ", "́́", "a‍", "‍a", "x\u{E0067}"];
  for (const s of samples) {
    const once = cleanTileLetters(s);
    assert.equal(cleanTileLetters(once ?? ""), once, `cleaning ${JSON.stringify(s)} twice`);
  }
});

test("tile letters stay at two graphemes and a bounded length whatever is typed or synced, and cleaning twice changes nothing", async () => {
  const { cleanTileLetters, TILE_LETTERS_MAX_LENGTH } = await import("./tileLetter.ts");
  assert.equal(cleanTileLetters("a‍b‍c"), "AB", "a joiner between letters joins nothing");
  const marked = cleanTileLetters("a" + "́".repeat(4096));
  assert.equal(marked, null, "a letter with more marks than the cap holds is left off whole");
  assert.equal(cleanTileLetters("a ́"), cleanTileLetters(cleanTileLetters("a ́")));
  assert.equal(cleanTileLetters("a ́"), "Á");
  assert.equal(cleanTileLetters("aß"), "AS");
  assert.equal(cleanTileLetters("👩‍💻"), "👩‍💻");
  assert.equal(cleanTileLetters("👨‍👩‍👧‍👦👨‍👩‍👧‍👦x"), "👨‍👩‍👧‍👦👨‍👩‍👧‍👦");
  assert.equal(cleanTileLetters("🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"), "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", "a subdivision flag is one");
  assert.equal(cleanTileLetters("\u{1F3FB}a"), "A", "a skin tone with no emoji goes");
  const samples = ["a‍b‍c", "a" + "́".repeat(4096), "a ́", "aß", "👩‍💻", "x" + "\u{E0067}".repeat(500), "🇫🇷🇩", "ǅx", "ﬀ", "ŉ", "İi", "ậ́̀b"];
  for (const s of samples) {
    const once = cleanTileLetters(s);
    assert.equal(cleanTileLetters(once ?? ""), once, `cleaning ${JSON.stringify(s)} twice`);
    assert.ok(!once || once.length <= TILE_LETTERS_MAX_LENGTH, JSON.stringify(once));
  }
});

test("for ordinary letters, accents, emoji and flags the tile's two graphemes are the ones Intl.Segmenter finds, which Hermes lacks", async () => {
  const { cleanTileLetters } = await import("./tileLetter.ts");
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const firstTwo = (text) => [...segmenter.segment(text.normalize("NFC").toLocaleUpperCase().normalize("NFC"))].slice(0, 2).map((s) => s.segment).join("");
  for (const text of ["gmail", "éclair", "👩‍💻dev", "👍🏽ok", "🇫🇷🇩🇪", "日本語", "한국어", "ق̈ar", "🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}x"]) assert.equal(cleanTileLetters(text), firstTwo(text), text);
});

test("tile letters follow Unicode's grapheme rules: symbols that aren't emoji count one each, an Indic conjunct is one, Hangul syllables and jamo join", async () => {
  const { cleanTileLetters } = await import("./tileLetter.ts");
  const { graphemeClusters } = await import("./graphemes.ts");
  assert.equal(cleanTileLetters("⌀⌀⌀"), "⌀⌀");
  assert.equal(cleanTileLetters("क्षअ"), "क्षअ");
  assert.deepEqual(graphemeClusters("क्षअ"), ["क्ष", "अ"]);
  assert.deepEqual(graphemeClusters("한국"), ["한", "국"]);
  assert.deepEqual(graphemeClusters("한"), ["한"]);
  assert.equal(cleanTileLetters("👩‍👩‍👧x"), "👩‍👩‍👧X");
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const samples = ["⌀⌀⌀", "क्षअ", "ক্ষমা", "ક્ષર", "త్రి", "ക്ഷേ", "한국어", "👩‍💻👨‍👩‍👧", "🇫🇷🇩🇪🇮🇹", "é̂x", "🏳️‍🌈x", "ﷺab", "؀١x", "ไทย", "ລາວ"];
  for (const text of samples) assert.deepEqual(graphemeClusters(text), [...segmenter.segment(text)].map((s) => s.segment), text);
});

test("tile letters keep a Khmer conjunct and its next letter, and a Zanabazar Square sign starts its own grapheme", async () => {
  const { cleanTileLetters } = await import("./tileLetter.ts");
  assert.equal(cleanTileLetters("ស្ករ"), "ស្ករ");
  assert.equal(cleanTileLetters("\u{11A3A}AA"), "\u{11A3A}A");
  assert.equal(cleanTileLetters("क्षअ"), "क्षअ");
  assert.equal(cleanTileLetters("⌀⌀⌀"), "⌀⌀");
  assert.equal(cleanTileLetters("👩‍💻👨‍👩‍👧x"), "👩‍💻👨‍👩‍👧");
});

test("tile letters normalise and upper-case only the basic plane, so Hermes, which composes a tag character as if it were a letter, cleans the same as V8", async () => {
  const { cleanTileLetters } = await import("./tileLetter.ts");
  assert.equal(cleanTileLetters("ำក\u{E0067}́⃣️"), "ក\u{E0067}́⃣️", "the tag stays a tag, and the leading spacing mark goes");
  assert.equal(cleanTileLetters("𐐨b"), "𐐨B", "an astral letter keeps its case");
  assert.equal(cleanTileLetters("éb"), "ÉB");
});

test("tile letters made only of characters that draw nothing, Braille Blank, the Hangul fillers and the Mongolian vowel separator, count as blank", async () => {
  const { cleanTileLetters } = await import("./tileLetter.ts");
  for (const blank of ["⠀", "ㅤ", "ﾠ", "ᅟ", "ᅠ", "᠎", "⠀ㅤ", " ⠀ "]) assert.equal(cleanTileLetters(blank), null, JSON.stringify(blank));
  assert.equal(cleanTileLetters("⠀aㅤb"), "AB", "a blank between letters takes no room");
  assert.equal(cleanTileLetters("⠁"), "⠁", "a Braille pattern with dots still counts");
  assert.equal(cleanTileLetters("가"), "가", "real jamo still join");
});

test("a Hangul filler inside a jamo syllable stays part of it, and an explicit non-joiner keeps two Indic letters apart (#4197)", async () => {
  const { cleanTileLetters } = await import("./tileLetter.ts");
  assert.equal(cleanTileLetters("\u1100\u1160\u1102\u1160B"), "\u1100\u1160\u1102\u1160", "two jamo syllables with a vowel filler are the two letters, B stays off");
  assert.equal(cleanTileLetters("\u0915\u094D\u200C\u0915B"), "\u0915\u094D\u200C\u0915", "an explicit non-joiner keeps two letters, not the conjunct");
  assert.equal(cleanTileLetters("\u0915\u094D\u0915B"), "\u0915\u094D\u0915B", "without it the conjunct is one letter and B follows");
  for (const value of ["\u1100\u1160\u1102\u1160B", "\u0915\u094D\u200C\u0915B", "\u115F\u1160x"]) assert.equal(cleanTileLetters(cleanTileLetters(value)), cleanTileLetters(value));
});

test("a site's default letter skips a Hangul filler that draws nothing", () => {
  assert.equal(tileLetterOf("https://127.0.0.1/", "\u3164News"), "N");
  assert.equal(tileLetterOf("", "\uFFA0\u115F\u1160Ok"), "O");
});

test("a letter that is only fillers and invisible marks is blank, and repeated invisible marks don't crowd out the second letter (#4197)", async () => {
  const { cleanTileLetters } = await import("./tileLetter.ts");
  for (const blank of ["\u2800\u200C", "\u3164\uFE0F", "\uFFA0\u034F", "\u2800\u200C\u3164\uFE0F"]) assert.equal(cleanTileLetters(blank), null, JSON.stringify(blank));
  assert.equal(cleanTileLetters("A" + "\u200C".repeat(23) + "B"), "A\u200CB");
  assert.equal(cleanTileLetters("A" + "\uFE0F".repeat(30) + "B"), "A\uFE0FB");
  assert.equal(cleanTileLetters("\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}x"), "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}X", "a tag flag keeps its tags");
  assert.equal(cleanTileLetters("\u2764\uFE0F"), "\u2764\uFE0F");
});

test("a second letter that doesn't fit whole is left off rather than cut, so a subdivision flag never loses its closing tag (#4197)", async () => {
  const { cleanTileLetters } = await import("./tileLetter.ts");
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
  const scotland = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
  assert.equal(cleanTileLetters(family + scotland), family);
  assert.equal(cleanTileLetters(scotland + family), scotland, "the flag first, then a family that would overflow, keeps the flag");
  assert.equal(cleanTileLetters("A" + scotland), "A" + scotland);
});

test("a single letter longer than the whole cap is left off whole, so the tile falls back to the site's letter instead of a cut sequence (#4197)", async () => {
  const { cleanTileLetters } = await import("./tileLetter.ts");
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
  const scotland = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
  assert.equal(cleanTileLetters(family + "\u200D" + scotland), null);
  assert.equal(cleanTileLetters("a" + "\u0301\u0302".repeat(20)), null);
  assert.equal(cleanTileLetters("a\u0301b"), "A\u0301B".normalize("NFC"));
});

test("a long paste is cut only between graphemes, so spaces before a flag can't split it, and a blank label saved earlier shows the site's letter (#4197)", async () => {
  const { cleanTileLetters, tileLettersOf } = await import("./tileLetter.ts");
  const scotland = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
  assert.equal(cleanTileLetters(" ".repeat(180) + scotland), scotland);
  for (let pad = 1520; pad < 1540; pad++) {
    const cleaned = cleanTileLetters(" ".repeat(pad) + scotland);
    assert.ok(cleaned === scotland || cleaned === null, `padding ${pad}: the flag is kept whole or left off, never cut`);
  }
  assert.equal(cleanTileLetters("x".repeat(5000)), "XX");
  assert.equal(tileLettersOf({ url: "https://mail.example/", title: "Mail", tileLetters: "\u2800" }), "M");
  assert.equal(tileLettersOf({ url: "https://mail.example/", title: "Mail", tileLetters: "GM" }), "GM");
});
