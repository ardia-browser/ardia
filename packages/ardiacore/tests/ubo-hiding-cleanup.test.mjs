import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const script = readFileSync(new URL("../scripts/ubo.sh", import.meta.url), "utf8");
const cleanup = /^hiding_cleanup = r'''\n([\s\S]*?)^'''$/m.exec(script)?.[1];

function findChromium() {
  const candidates = [process.env.ARDIA_TEST_CHROMIUM];
  const playwright = join(homedir(), "Library/Caches/ms-playwright");
  if (existsSync(playwright))
    for (const dir of readdirSync(playwright).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse())
      candidates.push(join(playwright, dir, "chrome-headless-shell-mac-arm64/chrome-headless-shell"), join(playwright, dir, "chrome-headless-shell-mac-x64/chrome-headless-shell"));
  candidates.push(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  );
  return candidates.find((path) => path && existsSync(path)) ?? null;
}

const chromium = findChromium();
const NO_CHROMIUM = !chromium && "no Chromium to run the cleanup in (set ARDIA_TEST_CHROMIUM)";

const toBase64 = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

function cleanInChromium(texts) {
  const dir = mkdtempSync(join(tmpdir(), "ubo-hiding-cleanup-"));
  try {
    const page = join(dir, "run.html");
    writeFileSync(
      page,
      `<!doctype html><meta charset="utf-8"><pre id="out"></pre><script>
const µb = {};
${cleanup}
const decode = (b64) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
const encode = (value) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
const texts = decode("${toBase64(texts)}");
const results = texts.map((text) => {
  const first = µb.ardiaCleanHidingRules(text, { countNeighbours: true });
  return { ...first, again: µb.ardiaCleanHidingRules(first.text).text };
});
document.getElementById("out").textContent = encode(results);
</script>`,
    );
    const dom = execFileSync(
      chromium,
      ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${join(dir, "profile")}`, "--dump-dom", `file://${page}`],
      { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const b64 = /<pre id="out">([A-Za-z0-9+/=]*)<\/pre>/.exec(dom)?.[1];
    assert.ok(b64, "the cleanup page produced no result");
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MARKER = "*##+js(set-constant, ardiaFixtureMarker, 1)";

const FIXTURES = [
  {
    name: "a: a comment-wrapped rule as 0.2.47 stored it is commented out part by part, in place",
    text: `||ads.example^\nnews.test##.promo\n127.0.0.1##x/*\r${MARKER}\r*/`,
    want: `||ads.example^\nnews.test##.promo\n! 127.0.0.1##x/*\r! ${MARKER}\r! */`,
    spans: 1,
    disabled: 3,
  },
  {
    name: "a: an unclosed comment as 0.2.47 stored it",
    text: `news.test##.promo\n127.0.0.1##x/*\r${MARKER}`,
    want: `news.test##.promo\n! 127.0.0.1##x/*\r! ${MARKER}`,
    spans: 1,
    disabled: 2,
  },
  {
    name: "a: a forgiving :is() as 0.2.47 stored it",
    text: `127.0.0.1##x:is(\r${MARKER}\r)\nnews.test##.promo`,
    want: `! 127.0.0.1##x:is(\r! ${MARKER}\r! )\nnews.test##.promo`,
    spans: 1,
    disabled: 3,
  },
  {
    name: "a: a continued attribute string as 0.2.47 stored it",
    text: `127.0.0.1##[a="\\\r${MARKER}\\\r"]\nnews.test##.promo`,
    want: `! 127.0.0.1##[a="\\\r! ${MARKER}\\\r! "]\nnews.test##.promo`,
    spans: 1,
    disabled: 3,
  },
  {
    name: "a: in a file with CRLF line ends",
    text: `news.test##.promo\r\n127.0.0.1##x/*\r${MARKER}\r*/\r\nlater.test##.banner\r\n`,
    want: `news.test##.promo\r\n! 127.0.0.1##x/*\r! ${MARKER}\r! */\r\nlater.test##.banner\r\n`,
    spans: 1,
    disabled: 3,
  },
  {
    name: "a: a plain hide inside the record keeps working",
    text: `127.0.0.1##x/*\rnews.test##.promo\r${MARKER}`,
    want: `! 127.0.0.1##x/*\rnews.test##.promo\r! ${MARKER}`,
    spans: 1,
    disabled: 2,
  },
  {
    name: "a: a scriptlet planted after a plain hide behind a carriage return is commented out where it stands",
    text: `news.test##.promo\nexample.test##.banner\r${MARKER}\nlater.test##.banner`,
    want: `news.test##.promo\nexample.test##.banner\r! ${MARKER}\nlater.test##.banner`,
    spans: 1,
    disabled: 1,
  },
  {
    name: "a: the same in a file with CRLF line ends",
    text: `example.test##.banner\r${MARKER}\r\nlater.test##.banner\r\n`,
    want: `example.test##.banner\r! ${MARKER}\r\nlater.test##.banner\r\n`,
    spans: 1,
    disabled: 1,
  },
  {
    name: "a: an HTML filter or a rewriting network option behind a carriage return is commented out too",
    text: "example.test##.banner\rexample.test##^script:has-text(x)\r||ads.example^$redirect=noop.js\r||ads.example^$third-party",
    want: "example.test##.banner\r! example.test##^script:has-text(x)\r! ||ads.example^$redirect=noop.js\r||ads.example^$third-party",
    spans: 1,
    disabled: 2,
  },
  {
    name: "a: a directive inside a carriage-return record stays where uBlock Origin reads it",
    text: `example.test##.banner\r!#if false\r${MARKER}\nkept1.example\n!#endif\nkept2.example`,
    want: `example.test##.banner\r!#if false\r! ${MARKER}\nkept1.example\n!#endif\nkept2.example`,
    spans: 1,
    disabled: 1,
  },
  {
    name: "b: the comment-wrapped rule saved again with line feeds: the rule, the scriptlet and the closer are commented out",
    text: `news.test##.promo\n127.0.0.1##x/*\n${MARKER}\n*/\nlater.test##.banner`,
    want: `news.test##.promo\n! 127.0.0.1##x/*\n! ${MARKER}\n! */\nlater.test##.banner`,
    spans: 1,
    disabled: 3,
  },
  {
    name: "b: the closer can carry more selector after it",
    text: `127.0.0.1##x/*\n${MARKER}\n*/ .y\nexample.test##+js(set-constant, userFlag, 1)`,
    want: `! 127.0.0.1##x/*\n! ${MARKER}\n! */ .y\nexample.test##+js(set-constant, userFlag, 1)`,
    spans: 1,
    disabled: 3,
  },
  {
    name: "b: a comment closed and opened again: blocking-pattern fragments stay",
    text: `127.0.0.1##x/*\n*/\n.y/*\n${MARKER}\n*/\nlater.test##.banner`,
    want: `! 127.0.0.1##x/*\n! */\n.y/*\n! ${MARKER}\n! */\nlater.test##.banner`,
    spans: 1,
    disabled: 4,
  },
  {
    name: "b: the forgiving :is() saved again with line feeds",
    text: `127.0.0.1##x:is(\n${MARKER}\n)\n||ads.example^`,
    want: `! 127.0.0.1##x:is(\n! ${MARKER}\n! )\n||ads.example^`,
    spans: 1,
    disabled: 3,
  },
  {
    name: "b: the continued attribute string saved again with line feeds",
    text: `127.0.0.1##[a="\\\n${MARKER}\\\n"]\nlater.test##.banner`,
    want: `! 127.0.0.1##[a="\\\n! ${MARKER}\\\n! "]\nlater.test##.banner`,
    spans: 1,
    disabled: 3,
  },
  {
    name: "b: a closed span keeps the blocking rules and conditional sections inside it working",
    text: `127.0.0.1##x/*\n${MARKER}\n!#if env_chromium\n||cond.example^\n!#endif\n*/\n||after.example^`,
    want: `! 127.0.0.1##x/*\n! ${MARKER}\n!#if env_chromium\n||cond.example^\n!#endif\n! */\n||after.example^`,
    spans: 1,
    disabled: 3,
  },
  {
    name: "b: a scriptlet continued on an indented line is commented out as one filter",
    text: `127.0.0.1##x/*\n*##+js(set-constant, ardiaFixtureMarker, \\\n    1)\n*/\n||after.example^`,
    want: `! 127.0.0.1##x/*\n! *##+js(set-constant, ardiaFixtureMarker, \\\n    1)\n! */\n||after.example^`,
    spans: 1,
    disabled: 3,
  },
  {
    name: "b: a span left open has no end to prove, so only its own line is commented out",
    text: `127.0.0.1##x/*\n${MARKER}\nlater.test##.banner\n||ads.example^\n! a note`,
    want: `! 127.0.0.1##x/*\n${MARKER}\nlater.test##.banner\n||ads.example^\n! a note`,
    spans: 1,
    disabled: 1,
  },
  {
    name: "b: a continued filter after an open span keeps working",
    text: `127.0.0.1##x/*\n${MARKER}\nexample.test##.cont \\\n    .tinued`,
    want: `! 127.0.0.1##x/*\n${MARKER}\nexample.test##.cont \\\n    .tinued`,
    spans: 1,
    disabled: 1,
  },
  {
    name: "b: a hand-written rule ending in an open comment leaves the rules after it alone",
    text: "example.test##.banner/*\n||ads.example^\nexample.test##+js(noeval)",
    want: "! example.test##.banner/*\n||ads.example^\nexample.test##+js(noeval)",
    spans: 1,
    disabled: 1,
  },
  {
    name: "b: with a closer after it, only the scriptlet and the closer go with it, and blocking rules stay",
    text: "example.test##.banner/*\n||ads.example^\nexample.test##+js(noeval)\n*/",
    want: "! example.test##.banner/*\n||ads.example^\n! example.test##+js(noeval)\n! */",
    spans: 1,
    disabled: 3,
  },
  ...[
    ["form feed", "\f"],
    ["vertical tab", "\v"],
    ["next line", "\u0085"],
    ["line separator", " "],
    ["paragraph separator", " "],
  ].map(([label, mark]) => ({
    name: `c: a closed comment holding a ${label}, which neither uBlock Origin nor its editor splits, stays one cosmetic rule`,
    text: `news.test##.promo\n127.0.0.1##x/*${mark}${MARKER}${mark}*/\nlater.test##.banner`,
    want: `news.test##.promo\n127.0.0.1##x/*${mark}${MARKER}${mark}*/\nlater.test##.banner`,
  })),
  {
    name: "d: a hand-written list with only carriage returns keeps every rule",
    text: "example.test##.banner\rtracker.test\r||ads.example^\rnews.test##.promo",
    want: "example.test##.banner\rtracker.test\r||ads.example^\rnews.test##.promo",
  },
  {
    name: "d: a selector continued across a carriage return in normal context stays, since only a blocking rule can come of it",
    text: "example.test##.banner >\rspan",
    want: "example.test##.banner >\rspan",
  },
  {
    name: "d: a scriptlet after a hide in a carriage-return list looks the same as a planted one, so it is commented out, not deleted",
    text: "example.test##.banner\rdiv\rexample.test##+js(set-constant, userFlag, 1)",
    want: "example.test##.banner\rdiv\r! example.test##+js(set-constant, userFlag, 1)",
    spans: 1,
    disabled: 1,
  },
  {
    name: "d: a carriage-return list of blocking rules and hides after a hide stays byte for byte",
    text: "example.test##.banner\r||ads.example^$third-party\r! a note\rnews.test##.promo",
    want: "example.test##.banner\r||ads.example^$third-party\r! a note\rnews.test##.promo",
  },
  {
    name: "e: a scriptlet on its own line after a hide stays: two lines a user wrote look exactly like that",
    text: `example.test##.banner\n${MARKER}`,
    want: `example.test##.banner\n${MARKER}`,
    neighbours: 1,
  },
  {
    name: "e: a user's own scriptlets and network rules stay, and next to a hide they are counted",
    text: "example.test##+js(set-constant, userFlag, 1)\nexample.test##.banner\n||ads.example^$script\n\nexample.test#@#+js()\nexample.test##div:has-text(Sponsored)",
    want: "example.test##+js(set-constant, userFlag, 1)\nexample.test##.banner\n||ads.example^$script\n\nexample.test#@#+js()\nexample.test##div:has-text(Sponsored)",
    neighbours: 2,
  },
  {
    name: "f: Hide Element rules stay, including a test attribute holding a comment opener",
    text: 'news.test##.promo\nnews.test##section[data-testid="promo/*card"]\nnews.test##div.a > span:nth-of-type(2)\nnews.test###top\nexample.test##.ad /* sidebar */\n',
    want: 'news.test##.promo\nnews.test##section[data-testid="promo/*card"]\nnews.test##div.a > span:nth-of-type(2)\nnews.test###top\nexample.test##.ad /* sidebar */\n',
  },
];

test("Hide Element cleanup comments out only what Hide Element could not have written, and deletes nothing", { skip: NO_CHROMIUM }, () => {
  assert.ok(cleanup, "ubo.sh has no hiding_cleanup block");
  const results = cleanInChromium(FIXTURES.map((f) => f.text));
  FIXTURES.forEach((fixture, i) => {
    const got = results[i];
    assert.equal(JSON.stringify(got.text), JSON.stringify(fixture.want), fixture.name);
    assert.equal(got.spans, fixture.spans ?? 0, `${fixture.name}: spans`);
    assert.equal(got.disabled, fixture.disabled ?? 0, `${fixture.name}: commented out`);
    if ("neighbours" in fixture) assert.equal(got.neighbours, fixture.neighbours, `${fixture.name}: next to a hide`);
    assert.equal(JSON.stringify(got.again), JSON.stringify(got.text), `${fixture.name}: a second pass changes nothing`);
  });
});

test("the cleanup runs before the engines load, holds back My filters reads and writes until it is done, and runs on every compile", () => {
  assert.match(script, /"µb\.saveUserFilters = async function\(content\) \{\\n"\n\s+"    await ardiaCleanupGate;\\n"\)/);
  assert.match(script, /"µb\.loadUserFilters = async function\(\) \{\\n"\n\s+"    await ardiaCleanupGate;\\n"/);
  assert.match(script, /patch\("js\/start\.js",\n\s+"    \/\/ Prime the filtering engines before first use\.\\n",\n\s+"    await µb\.ardiaRemoveSplitHidingRules\(\);/);
  assert.match(script, /rawText = µb\.ardiaCleanHidingRules\(rawText\)\.text;/);
  assert.match(script, /compiledMagic: 173,/);
  assert.match(script, /selfieMagic: 173,/);
  assert.match(script, /selfie\/staticArdia2/);
});

function startupFlow() {
  const from = script.indexOf('"let ardiaCleanupGate = Promise.resolve();\\n"');
  const to = script.indexOf('"µb.saveUserFilters = async function(content) {\\n"');
  assert.ok(from > 0 && to > from, "ubo.sh has the startup cleanup flow");
  return script
    .slice(from, to)
    .split("\n")
    .map((line) => /^\s*"(.*)"\s*$/.exec(line)?.[1])
    .filter((literal) => literal !== undefined)
    .map((literal) => JSON.parse(`"${literal}"`))
    .join("");
}

function runStartup({ content = null, backupDelayMs = 0 }) {
  const writes = [];
  const storage = {};
  const context = {
    console,
    Promise,
    setTimeout: (fn, ms) => setTimeout(fn, ms / 1000),
    ubolog: () => {},
    recordWrite: (text) => void writes.push(text),
    vAPI: {
      storage: {
        get: async (key) => ({ [key]: storage[key] }),
        set: async (bin) => {
          await new Promise((r) => setTimeout(r, backupDelayMs));
          Object.assign(storage, bin);
        },
      },
    },
    µb: {
      userFiltersPath: "user-filters",
      selfieManager: { destroy() {} },
      removeCompiledFilterList() {},
      ardiaCleanHidingRules: (text) => ({ text: text + "!", spans: 1, disabled: 1, neighbours: 0 }),
    },
  };
  const io = `const io = { get: ${JSON.stringify(content)} === null ? () => new Promise(() => {}) : async () => ({ content: ${JSON.stringify(content)} }), put: async (key, text) => recordWrite(text) };`;
  vm.runInNewContext(`${io}\n${startupFlow()}\nthis.start = () => µb.ardiaRemoveSplitHidingRules();`, context);
  return { start: context.start, writes };
}

test("a storage call that never settles holds startup for the deadline only, and nothing is written after it", { timeout: 5000 }, async () => {
  const stuck = runStartup({});
  const started = Date.now();
  await stuck.start();
  assert.ok(Date.now() - started < 1000, "the gate opens at the deadline");
  assert.deepEqual(stuck.writes, []);

  const late = runStartup({ content: "example.test##x/*", backupDelayMs: 40 });
  await late.start();
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(late.writes, [], "a cleanup that finishes its backup after the deadline leaves My filters alone");

  const quick = runStartup({ content: "example.test##x/*" });
  await quick.start();
  assert.deepEqual(quick.writes, ["example.test##x/*!"], "a cleanup within the deadline writes once");
});
