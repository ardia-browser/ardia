import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPaste, fixupUrl, isJavaScriptUrl, resolveInput } from "./omnibox.ts";
import { customEnginesFrom, validSearchTemplate } from "./engines.ts";
import { HOSTILE_STRINGS, HOSTILE_VALUES, URL_SCHEMES } from "../../../scripts/security/hostile-inputs.mjs";

const strings = HOSTILE_STRINGS.map((h) => h.value);
const SCRIPT_SCHEME = /^\s*(?:view-source:)?(?:javascript|vbscript):/i;
const SEARCH = "https://search.example/?q=%s";

test("typed or pasted text never resolves to a script address, however the scheme is dressed up", () => {
  for (const s of strings)
    for (const typed of [s, `${s}${URL_SCHEMES.javascript}`, `${URL_SCHEMES.javascript}${s}`]) {
      const resolved = resolveInput(typed, SEARCH);
      assert.ok(!SCRIPT_SCHEME.test(resolved) && !isJavaScriptUrl(resolved), JSON.stringify(typed).slice(0, 120));
      const fixed = fixupUrl(typed);
      assert.ok(fixed === null || !isJavaScriptUrl(fixed), JSON.stringify(typed).slice(0, 120));
      const paste = classifyPaste(typed);
      if (paste?.kind === "go") assert.ok(!isJavaScriptUrl(paste.url) && !/^(?:about|data):/i.test(paste.url), JSON.stringify(typed).slice(0, 120));
    }
});

test("a search template is only an http or https address with %s, and a custom engine keeps only its declared fields", () => {
  for (const { value } of HOSTILE_VALUES) {
    const template = validSearchTemplate(value);
    if (template) assert.match(value as string, /^https?:\/\/[^/?#\s]+/i);
    for (const raw of [value, [value], [{ id: "a", name: "a", keyword: "a", url: value, suggestUrl: value, extra: value }]])
      for (const engine of customEnginesFrom(raw)) {
        assert.deepEqual(Object.keys(engine).sort(), ["id", "keyword", "name", "url"]);
        assert.ok(validSearchTemplate(engine.url));
      }
  }
});

test("a search for text with a lone surrogate half goes out with the replacement character instead of throwing", () => {
  const lone = String.fromCharCode(0xd800);
  assert.equal(resolveInput(`a${lone}b`, SEARCH), "https://search.example/?q=a%EF%BF%BDb");
  assert.equal(resolveInput("a\u{1F600}b", SEARCH), "https://search.example/?q=a%F0%9F%98%80b");
});
