import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../scripts/ubo.sh", import.meta.url), "utf8");
const python = /<<'PY'\n([\s\S]*?)\nPY\n/.exec(script)?.[1];

test("ubo.sh prepares uBlock Origin with one embedded Python script", () => {
  assert.ok(python, "the heredoc between <<'PY' and PY is there");
});

test("ubo.sh reads and writes uBlock Origin's files as UTF-8 bytes with their own line endings on every host", () => {
  const opens = [...python.matchAll(/\bopen\(([^()]*)\)/g)].map((match) => match[1]);
  assert.ok(opens.length >= 4, "the script opens the manifest and the patched sources");
  for (const args of opens) {
    assert.match(args, /encoding="utf-8"/, `open(${args}) names UTF-8, which Windows' default code page is not`);
    assert.match(args, /newline=""/, `open(${args}) keeps the file's line endings, which Windows would turn into CRLF`);
  }
});
