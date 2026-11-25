import assert from "node:assert/strict";
import { after, test } from "node:test";
import { HOSTILE_STRINGS, embedded } from "../../../../../scripts/security/hostile-inputs.mjs";
import { CHROMIUM_MISSING, launchChromium } from "../../../../../scripts/lib/test-chromium.mjs";
import { HIDING_CLEANUP, OfflineError, pinnedUblock } from "../../../../../scripts/lib/ublock-pinned.mjs";
const { hidingFilter, parseHidingFilter, savablePickedSelector } = await import("./hiddenElements.ts");

let ublock = null;
let unavailable = CHROMIUM_MISSING;
if (!unavailable) {
  try {
    ublock = await pinnedUblock();
    after(() => ublock.remove());
  } catch (error) {
    if (!(error instanceof OfflineError) || process.env.CI) throw error;
    unavailable = error.message;
  }
}
assert.ok(HIDING_CLEANUP, "ubo.sh still holds the hiding cleanup Ardia's compiler runs");

const PARSER_OPTIONS = { trustedSource: true, nativeCssHas: true, maxTokenLength: 7, trustedTokens: new Set() };
const ENV = ["chromium", "ublock", "native_css_has"];

function compiledRecords(text) {
  const { sfp, LineIterator, cosmetic } = ublock;
  const parser = new sfp.AstFilterParser(PARSER_OPTIONS);
  const records = [];
  const writer = {
    properties: new Map([["name", "user-filters"]]),
    section: "",
    select(section) {
      this.section = section;
    },
    push(args) {
      records.push(JSON.stringify(["cosmetic", this.section, ...args]));
    },
  };
  const lines = new LineIterator(sfp.utils.preparser.prune(text, ENV));
  while (!lines.eot()) {
    let line = lines.next();
    while (line.endsWith(" \\")) {
      if (lines.peek(4) !== "    ") break;
      line = line.slice(0, -2).trim() + lines.next().trim();
    }
    parser.parse(line);
    if (!parser.isFilter()) continue;
    if (parser.hasError()) records.push(JSON.stringify(["refused", line]));
    else if (parser.isNetworkFilter()) records.push(JSON.stringify(["network", line]));
    else if (parser.isScriptletFilter()) records.push(JSON.stringify(["scriptlet", line]));
    else if (parser.isHtmlFilter()) records.push(JSON.stringify(["html", line]));
    else if (parser.isResponseheaderFilter()) records.push(JSON.stringify(["responseheader", line]));
    else cosmetic.compile(parser, writer);
  }
  return records;
}

const appendUserFilters = (content, filters) => `${content.trim()}\n${filters.join("\n").trim()}`;

const USER_LIST = [
  "! Title: My filters",
  "||ads.example^",
  "news.test##.promo",
  "!#if env_firefox",
  "example.org##+js(set-constant, ardiaFixtureMarker, 1)",
  "!#endif",
  "example.net##div.banner \\",
  "    , aside.banner",
].join("\n");

let page = null;
async function shippedCleanup(texts) {
  return page.evaluate(({ texts, code }) => {
    const µb = {};
    new Function("µb", code)(µb);
    return texts.map((text) => µb.ardiaCleanHidingRules(text).text);
  }, { texts, code: HIDING_CLEANUP });
}

async function recordsAddedBy(batches) {
  const [base, ...after] = await shippedCleanup([USER_LIST, ...batches.map((filters) => appendUserFilters(USER_LIST, filters))]);
  const before = compiledRecords(base);
  return after.map((text) => {
    const records = compiledRecords(text);
    for (const record of before) {
      const at = records.indexOf(record);
      assert.ok(at >= 0, `appending changed an existing rule: ${record}`);
      records.splice(at, 1);
    }
    return records.map((r) => JSON.parse(r));
  });
}

const plainRecord = (filter, compiled) => ["cosmetic", "COSMETIC_FILTERS:SPECIFIC", 8, filter.slice(0, filter.indexOf("##")), `+${compiled}`];

function assertPlainCosmetic(added, filter, input, { refusedIsInert }) {
  const where = JSON.stringify(input).slice(0, 160);
  if (refusedIsInert && added.length === 1 && added[0][0] === "refused" && added[0][1] === filter) return "refused";
  assert.equal(added.length, 1, `${where}: exactly one compiled record, got ${JSON.stringify(added)}`);
  const [record] = added;
  assert.equal(record[0], "cosmetic", `${where}: a cosmetic record, not ${record[0]}`);
  assert.deepEqual(record.slice(0, 4), plainRecord(filter, "").slice(0, 4), `${where}: a hiding rule for the page's host only`);
  assert.ok(record[4].startsWith("+") && !record[4].startsWith("+{"), `${where}: plain CSS, not a procedural or action filter: ${record[4]}`);
  return "plain";
}

const HOST = "ardia-fixture.test";

const PICKER_SHAPES = [
  "#fixture-banner",
  "div.ad-slot",
  "main > section:nth-of-type(2) > aside.promo",
  'section[data-testid="promo"]',
  'section[data-testid="promo/\\2a card"]',
  'a[data-qa="a\\9 b"]',
  "div.sc\\:x",
  "x-ad-box",
];

const UBLOCK_ONLY = [
  "div:style(display: none !important)",
  "div:remove()",
  "div:remove-attr(class)",
  "div:remove-class(ad)",
  "div:has-text(ardiaFixtureMarker)",
  "div:not(:has-text(x))",
  "div:has(:has-text(x))",
  ":is(div):remove()",
  "div, span:has-text(x)",
  "div:matches-css(display: block)",
  "html:matches-path(/x) div",
  ":is(:has-text(x))",
  "div:is(:style(x))",
  "div:where(:remove())",
  "div:upward(2)",
  "div:xpath(//a)",
  "a:is(.x):watch-attr(y)",
  "div:others()",
  "div:min-text-length(3)",
  "div:-abp-has(span)",
  "div:-abp-contains(x)",
  "div:if(span)",
  "div:if-not(span)",
  "div:nth-ancestor(1)",
  "div:shadow(span)",
  "div:matches-media((min-width: 1px))",
  "div:matches-prop(x)",
  "div:matches-attr(x)",
  "div:contains(x)",
  "div::before",
  "div:has(span)",
];

function savedFilters() {
  const inputs = [...PICKER_SHAPES, ...UBLOCK_ONLY, ...HOSTILE_STRINGS.flatMap(({ value }) => [...embedded(value, "div", "p"), `[data-testid="${value}"]`, `section[data-testid="a${value}b"]`])];
  const saved = new Map();
  for (const selector of inputs)
    for (const candidate of [selector, savablePickedSelector(selector)]) {
      const filter = typeof candidate === "string" ? hidingFilter(HOST, candidate) : null;
      if (filter !== null) saved.set(filter, selector);
    }
  return saved;
}

const cssTakes = (filters) =>
  page.evaluate((filters) => filters.map((f) => {
    try {
      document.createDocumentFragment().querySelector(f.slice(f.indexOf("##") + 2));
      return true;
    } catch {
      return false;
    }
  }), filters);

test("the pinned uBlock compiles every rule the picker can save, after Ardia's cleanup, to one plain cosmetic record or refuses it", { skip: unavailable, timeout: 60_000 }, async (t) => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  page = await browser.newPage();
  const saved = savedFilters();
  const filters = [...saved.keys()];
  const added = await recordsAddedBy(filters.map((f) => [f]));
  const takes = await cssTakes(filters);
  const outcomes = { plain: 0, refused: 0 };
  filters.forEach((filter, i) => {
    outcomes[assertPlainCosmetic(added[i], filter, saved.get(filter), { refusedIsInert: !takes[i] })]++;
  });
  t.diagnostic(`${filters.length} saved filters: ${outcomes.plain} plain cosmetic records, ${outcomes.refused} refused by uBlock and by the blockers' CSS check`);
  for (const selector of PICKER_SHAPES) assert.ok(hidingFilter(HOST, selector), `${selector}: an ordinary pick still saves`);
  assert.ok(outcomes.plain >= PICKER_SHAPES.length);

  const batch = PICKER_SHAPES.map((selector) => hidingFilter(HOST, selector));
  const [together] = await recordsAddedBy([batch]);
  assert.equal(together.length, batch.length, "a batch adds one record per pick");
  for (const record of together) assert.ok(record[0] === "cosmetic" && record[3] === HOST && /^\+[^{]/.test(record[4]), JSON.stringify(record));
});

test("uBlock-only selector syntax is never saved from a pick, even where a browser's querySelector would take it", () => {
  for (const selector of UBLOCK_ONLY) assert.equal(hidingFilter(HOST, selector), null, selector);
  assert.equal(hidingFilter(HOST, 'div[title="a:style(b)"]'), 'ardia-fixture.test##div[title="a:style(b)"]', "a colon inside a quoted value is data");
});

test("the Hidden Elements list reads every ordinary pick back as the selector that was saved", () => {
  for (const selector of PICKER_SHAPES) {
    const filter = hidingFilter(HOST, selector);
    assert.equal(parseHidingFilter(filter)?.selector, selector);
  }
});
