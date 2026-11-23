import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const SKIP = new Set(["node_modules", "dist", "build", "ios", "android", "macos", "windows", "Pods"]);
const SOURCE = /\.(ts|tsx)$/;

function sources(dir) {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) out.push(...sources(path));
    else if (SOURCE.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const packageSources = readdirSync(join(root, "packages")).flatMap((name) => {
  try {
    return statSync(join(root, "packages", name, "src")).isDirectory() ? sources(join("packages", name, "src")) : [];
  } catch {
    return [];
  }
});
const files = [...sources("apps/browser/src"), ...sources("apps/linux/src"), ...sources("apps/phone/src"), ...packageSources].map((path) => ({
  path: relative(root, join(root, path)).split(sep).join("/"),
  text: readFileSync(join(root, path), "utf8"),
}));
const FIXTURES = new Set(["apps/browser/src/platform/linkSinkTypeChecks.ts", "apps/phone/src/platform/linkSinkTypeChecks.ts"]);
const callersOf = (pattern) => files.filter((f) => !FIXTURES.has(f.path) && pattern.test(f.text)).map((f) => f.path).sort();

test("the sources scanned cover the Mac, Linux and phone UI and the shared packages", () => {
  for (const path of ["apps/browser/src/platform/clipboard.ts", "apps/phone/src/platform/system.ts", "apps/linux/src/linkShareSurface.ts", "packages/core/src/cleanUrl.ts"])
    assert.ok(files.some((f) => f.path === path), path);
});

const UNCLEANED_COPIES = {
  "apps/browser/src/state/downloads/downloadMenu.ts": "download links are often signed, so dropping a parameter breaks them",
  "apps/browser/src/state/omnibox/paste.ts": "address bar copies what it shows (owner decision)",
};

test("only the listed callers copy an address without cleaning it, each for its stated reason", () => {
  assert.deepEqual(callersOf(/\bcopyUncleanedUrl\(/), Object.keys(UNCLEANED_COPIES).sort());
  for (const reason of Object.values(UNCLEANED_COPIES)) assert.ok(reason.length > 0);
});

const BRANDS = new Set(["CleanedUrl", "LinkText"]);

function brandCasts(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names = new Set(BRANDS);
  const namespaces = new Set();
  const aliases = [];
  const visitDeclarations = (node) => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements) if (BRANDS.has((element.propertyName ?? element.name).text)) names.add(element.name.text);
    }
    if (ts.isTypeAliasDeclaration(node)) aliases.push(node);
    ts.forEachChild(node, visitDeclarations);
  };
  visitDeclarations(source);
  const mentionsBrand = (typeNode) => {
    let found = false;
    const look = (node) => {
      if (ts.isTypeReferenceNode(node)) {
        const name = node.typeName;
        if (ts.isIdentifier(name) && names.has(name.text)) found = true;
        if (ts.isQualifiedName(name) && BRANDS.has(name.right.text) && ts.isIdentifier(name.left) && namespaces.has(name.left.text)) found = true;
      }
      if (!found) ts.forEachChild(node, look);
    };
    look(typeNode);
    return found;
  };
  for (let grew = true; grew; ) {
    grew = false;
    for (const alias of aliases) if (!names.has(alias.name.text) && mentionsBrand(alias.type)) grew = !!names.add(alias.name.text);
  }
  const casts = [];
  const visitCasts = (node) => {
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) && mentionsBrand(node.type)) casts.push(node.getText(source));
    ts.forEachChild(node, visitCasts);
  };
  visitCasts(source);
  return casts;
}

test("a cleaned address or link text is only ever made by the cleaner, whatever name the brand is imported or aliased under", () => {
  const casting = files.filter((f) => !FIXTURES.has(f.path) && brandCasts(f.path, f.text).length).map((f) => f.path).sort();
  assert.deepEqual(casting, ["packages/core/src/cleanUrl.ts"]);
});

test("the cast check sees renamed imports, type aliases and namespace imports", () => {
  const sample = `import type { CleanedUrl as Clean, LinkText } from "@ardia/core";
import * as core from "@ardia/core";
type Mine = Clean | null;
type Text = LinkText;
const a = "x" as Clean;
const b = "x" as Mine;
const c = <Text>"x";
const d = "x" as core.CleanedUrl;
const e = "x" as unknown as string;`;
  assert.deepEqual(brandCasts("sample.ts", sample), ['"x" as Clean', '"x" as Mine', '<Text>"x"', '"x" as core.CleanedUrl']);
});

test("only the platform clipboard modules call the native copy bridge, so app code can't hand it a raw address", () => {
  assert.deepEqual(callersOf(/\.copy(?:Text|URL)\??\.?\(/), [
    "apps/browser/src/platform/clipboard.ts",
    "packages/expo-windows/src/selfCheck/shell.ts",
    "packages/expo-windows/src/shellClipboard.ts",
  ]);
  assert.deepEqual(callersOf(/\bsetStringAsync\(/), ["apps/phone/src/platform/system.ts"]);
});

test("plain text copies and shares never take an address: links go through copyLink and the link sinks", () => {
  const offenders = files.flatMap((f) =>
    [...f.text.matchAll(/(?<![.\w])(?:copyText|shareText)\(([^)]*)\)/g)].filter(([, argument]) => /url|href|link|address/i.test(argument)).map(([call]) => `${f.path}: ${call}`),
  );
  assert.deepEqual(offenders, []);
});

test("the phone shares links only through its branded sinks or a cleaned ShareLink", () => {
  assert.deepEqual(callersOf(/\bShare\.share\(/), ["apps/phone/src/platform/system.ts"]);
  assert.deepEqual(callersOf(/\.sharePage\(/).filter((path) => path.startsWith("apps/phone/")), ["apps/phone/src/platform/system.ts"]);
  const shareLinks = files.flatMap((f) => [...f.text.matchAll(/<ShareLink\b[^>]*>/g)].map(([tag]) => `${f.path}: ${tag}`));
  assert.ok(shareLinks.length > 0);
  for (const tag of shareLinks) assert.match(tag, /item=\{cleanUrl\(/, tag);
});
