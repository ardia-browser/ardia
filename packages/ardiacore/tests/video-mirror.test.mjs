import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const pageScript = read("../ios/page_script.js");
const native = read("../ios/ArdiaVideoMirror.mm");
const messages = read("../ios/ArdiaWebView+PageMessages.mm");
const podspec = read("../ios/ArdiaCore.podspec");
const applier = read("../ios/video_mirror.js");
const between = (text, start, end) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `${start} not found`);
  const to = text.indexOf(end, from + start.length);
  assert.ok(to > from, `${end} not found after ${start}`);
  return text.slice(from, to);
};
const block = between(pageScript, "  const videoMirror = (() => {", "  let bridgesProtectedPlayback = () => false;");
const constant = (name) => Number(block.match(new RegExp(`const ${name} = (\\d+);`))[1]);
const origins = (text) => [...text.matchAll(/"(https:\/\/[a-z.]+)"/g)].map((m) => m[1]).sort();

test("the mirror serves the protected video sites and YouTube's FairPlay movies only, named the same by the page script and the native side", () => {
  const page = origins(between(block, "const MIRROR_ORIGINS = [", "];"));
  const bridged = [between(pageScript, "const PROTECTED_VIDEO_ORIGINS = [", "];"), between(pageScript, "const HLS_VIDEO_ORIGINS = [", "];")];
  assert.deepEqual(page, origins(bridged.join(",")));
  assert.deepEqual(origins(between(native, "+ (BOOL)acceptsOrigin:", "\n}\n").replace(/@"/g, '"')), page);
  assert.match(messages, /\[kind isEqualToString:@"videoMirror"\] && main && dict && \[ArdiaVideoMirror acceptsOrigin:VerifiedOrigin\(verifiedOrigin\)\]/);
  assert.match(between(native, "+ (BOOL)acceptsOrigin:", "\n}\n"), /return TestMode\(\) &&/);
});

test("the mirror's page goes away with the page, the tab and a discard", () => {
  assert.match(between(messages, "- (void)resetPageMedia {", "\n}\n"), /\[ArdiaVideoMirror pageGoneFromTab:_tab\];/);
  const tab = read("../ios/ArdiaWebView+Tab.mm");
  assert.match(between(tab, "- (void)tabWillClose:", "\n}\n"), /\[ArdiaVideoMirror pageGoneFromTab:tab\];/);
  assert.match(between(tab, "- (void)tabDidChangeDiscarded:", "\n}\n"), /if \(tab\.discarded\) \[ArdiaVideoMirror pageGoneFromTab:tab\];/);
});

test("the applier ships in the app and its page runs no script of its own", () => {
  assert.match(podspec, /s\.resources\s*=.*'video_mirror\.js'/);
  assert.match(native, /script-src 'none'/);
  assert.match(native, /allowsContentJavaScript = NO/);
  assert.match(native, /WKWebsiteDataStore\.nonPersistentDataStore/);
  assert.match(native, /- \(NSView \*\)hitTest:\(NSPoint\)point \{\n  return nil;\n\}/);
  for (const tag of ["script", "iframe", "object", "embed", "meta", "base", "link", "template"]) assert.match(applier, new RegExp(`"${tag}"`));
});

test("state pseudo-classes become the attributes the mirror sets", () => {
  const rewrite = new Function(`${between(block, "    const PSEUDO = ", "    const STATES = ")}${between(block, "    const rewriteSelector = ", "    const absolutize = ")}return rewriteSelector;`)();
  assert.equal(rewrite(".a:hover > .b:focus-visible"), ".a[data-ardia-hover] > .b[data-ardia-focus-visible]");
  assert.equal(rewrite("x-badge:not(:defined)"), "x-badge:not(:not([data-ardia-undefined]))");
  assert.equal(rewrite(":host(:focus-within) .c:active"), ":host([data-ardia-focus-within]) .c[data-ardia-active]");
  assert.equal(rewrite("video:-webkit-full-screen, div:fullscreen"), "video[data-ardia-fullscreen], div[data-ardia-fullscreen]");
  assert.equal(rewrite(".x\\:hover, .y:hovered, .z:first-child"), ".x\\:hover, .y:hovered, .z:first-child");
});

test("a batch splits into parts the native side accepts, whatever its text", () => {
  const ship = new Function(
    "s",
    "send",
    "stop",
    "toJSON",
    "encoder",
    `const PART_CHARS = ${constant("PART_CHARS")}; const PART_BYTES = ${constant("PART_BYTES")}; const BATCH_CHARS = ${constant("BATCH_CHARS")};
    ${between(block, "    const ship = ", "    const resetTracking = ")}return ship;`,
  );
  const maxChars = Number(native.match(/kMaxPartChars = (\d+);/)[1]);
  const maxParts = Number(native.match(/kMaxParts = (\d+);/)[1]);
  const maxBatch = Number(native.match(/kMaxBatchChars = (\d+);/)[1]);
  assert.ok(constant("BATCH_CHARS") + 1000 <= maxBatch);
  for (const filler of ["a", "\u{1F3AC}", '"\\', "\u0001", "\u00e9\u4e2d"]) {
    const sent = [];
    let stopped = false;
    const batch = { t: "s", text: filler.repeat(Math.ceil(300000 / filler.length)) };
    ship({ seq: 0 }, (kind, data) => sent.push(data), () => (stopped = true), JSON.stringify, new TextEncoder())(batch);
    assert.equal(stopped, false);
    assert.ok(sent.length > 1 && sent.length <= maxParts);
    assert.equal(sent.map((m) => m.data).join(""), JSON.stringify(batch));
    for (const [i, m] of sent.entries()) {
      assert.equal(m.part, i);
      assert.equal(m.parts, sent.length);
      assert.ok(m.data.length <= maxChars);
      assert.ok(Buffer.byteLength(JSON.stringify(m)) < 64000, `part ${i} of ${JSON.stringify(filler)} fits a message`);
      assert.ok(!/[\ud800-\udbff]$/.test(m.data) && !/^[\udc00-\udfff]/.test(m.data), "no part splits a surrogate pair");
    }
  }
  let stopped = false;
  ship({ seq: 0 }, () => {}, () => (stopped = true), JSON.stringify, new TextEncoder())({ text: "a".repeat(constant("BATCH_CHARS")) });
  assert.equal(stopped, true);
});

const applierSheets = () => {
  class Sheet {
    replaceSync(text) {
      this.text = text;
    }
  }
  const head = {
    links: [],
    querySelectorAll: () => [...head.links],
    append: (link) => head.links.push(link),
  };
  const document = {
    adoptedStyleSheets: [],
    head,
    createElement: () => {
      const link = { dataset: {}, remove: () => head.links.splice(head.links.indexOf(link), 1) };
      return link;
    },
  };
  const agent = new Sheet();
  const base = new Sheet();
  const rootFrame = new Sheet();
  const shadows = new Map();
  const source = between(applier, "  const putSheet = ", "  const setState = ");
  const api = new Function(
    "CSSStyleSheet",
    "document",
    "agent",
    "base",
    "rootFrame",
    "shadows",
    `const sheets = new Map(); const scopeSheetLists = new Map(); let documentSheets = [];
    const scopeSheets = (extra) => [agent, ...extra, base];
    ${source}return { putSheet, listSheets, sheets };`,
  )(Sheet, document, agent, base, rootFrame, shadows);
  return { ...api, document, shadows, head };
};

test("a cross-origin sheet the page fetched later replaces its link in the document and in shadow roots", () => {
  const { putSheet, listSheets, sheets, document, shadows, head } = applierSheets();
  const root = { adoptedStyleSheets: [] };
  shadows.set(7, root);
  putSheet({ o: "put", id: 5, h: "https://cdn.example/a.css", m: "" });
  listSheets({ o: "sl", i: 0, l: [5] });
  listSheets({ o: "sl", i: 7, l: [5] });
  assert.equal(head.links.length, 1);
  assert.equal(document.adoptedStyleSheets.length, 3);
  putSheet({ o: "put", id: 5, x: ".play{color:red}" });
  const fetched = sheets.get(5);
  assert.equal(fetched.text, ".play{color:red}");
  assert.ok(document.adoptedStyleSheets.includes(fetched));
  assert.ok(root.adoptedStyleSheets.includes(fetched));
  assert.equal(head.links.length, 0);
});

const sheetSignatures = () => {
  const asNative = new Function(`${between(pageScript, "  const asNative = ", "  const { keys, setPrototypeOf } = Object;")}return asNative;`)();
  let scheduled = 0;
  const source = between(block, "    const sheetEdits = new WeakMap();", "    const sheetList = ");
  const api = new Function(
    "apply",
    "asNative",
    "MIRROR_ORIGINS",
    "location",
    "window",
    "absolutize",
    "listText",
    "fetched",
    "fetchSheet",
    "document",
    "getS",
    "schedule",
    `${source.replaceAll("if (s) schedule();", "if (getS()) schedule();")}return { sheetEntry, watchSheetEdits };`,
  )(
    Reflect.apply,
    asNative,
    [],
    { origin: "https://example.com" },
    {},
    (text) => text,
    (rules) => rules.map((r) => r.text).join("\n"),
    new Map(),
    () => {},
    { baseURI: "https://example.com/" },
    () => true,
    () => scheduled++,
  );
  return { ...api, scheduled: () => scheduled };
};

test("a sheet's signature changes when its media changes or the page edits it through the CSS object model", () => {
  const { sheetEntry, watchSheetEdits, scheduled } = sheetSignatures();
  class FakeSheet {
    replaceSync(text) {
      this.cssRules = [{ text }];
    }
  }
  watchSheetEdits(FakeSheet.prototype, ["replaceSync"], (sheet) => sheet);
  const sheet = new FakeSheet();
  sheet.cssRules = [{ text: ".a{color:red}" }];
  sheet.media = { mediaText: "" };
  sheet.href = null;
  const first = sheetEntry(sheet).sig;
  sheet.replaceSync(".a{color:blue}");
  const edited = sheetEntry(sheet).sig;
  assert.notEqual(edited, first);
  assert.equal(scheduled(), 1);
  assert.equal(sheetEntry(sheet).x(), ".a{color:blue}");
  sheet.media.mediaText = "print";
  assert.notEqual(sheetEntry(sheet).sig, edited);
  assert.equal(FakeSheet.prototype.replaceSync.name, "replaceSync");
  assert.match(block, /watchSheetEdits\(window\.CSSStyleDeclaration && CSSStyleDeclaration\.prototype, \["setProperty", "removeProperty", "cssText"\], \(style\) => ruleSheet\(style\.parentRule\)\);/);
  assert.match(block, /watchSheetEdits\(window\.CSSStyleRule && CSSStyleRule\.prototype, \["selectorText"\], ruleSheet\);/);
  assert.match(block, /watchSheetEdits\(window\.CSSGroupingRule && CSSGroupingRule\.prototype, \["insertRule", "deleteRule"\], ruleSheet\);/);
});
