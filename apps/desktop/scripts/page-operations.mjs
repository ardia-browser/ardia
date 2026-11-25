#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL?.endsWith(".ts")) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
  load(url, context, next) {
    return url.endsWith(".ts") ? next(url, { ...context, format: "module-typescript" }) : next(url, context);
  },
});

const USAGE = `usage: page-operations.mjs [--check|--write]
Derives the page evaluations the Linux host may run from the shared browser sources
and pins their exact text by length and SHA-256 in ac_linux_page_operations.h.`;

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TABLE = `${ROOT}engine/ardiacore-linux/src/ardia/linux/ac_linux_page_operations.h`;
const SELECTION = "apps/browser/src/state/site/selection.ts";
const COMMANDS = "apps/browser/src/state/commands/commands.ts";
const READER_PAGE = "apps/browser/src/state/reader/readerPage.ts";
const READER_TOKENS = "apps/browser/src/state/reader/tokens.ts";

const PICKER_HOST = "apps/desktop/src/elementPickerHost.ts";

const readerPage = await import(new URL(READER_PAGE, `file://${ROOT}`).href);
const pickerHost = await import(new URL(PICKER_HOST, `file://${ROOT}`).href);
const { pickerCall } = await import(new URL("apps/browser/src/state/site/elementPicker.ts", `file://${ROOT}`).href);
const { READER_FONTS, READER_SIZES } = await import(new URL(READER_TOKENS, `file://${ROOT}`).href);

function parse(path) {
  return ts.createSourceFile(path, readFileSync(`${ROOT}${path}`, "utf8"), ts.ScriptTarget.Latest, true);
}

function constants(source) {
  const found = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        (ts.isNoSubstitutionTemplateLiteral(node.initializer) || ts.isTemplateExpression(node.initializer) || ts.isStringLiteral(node.initializer))) {
      found.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const resolve = (name, seen = new Set()) => {
    const node = found.get(name);
    if (!node || seen.has(name)) throw new Error(`cannot resolve ${name}`);
    seen.add(name);
    if (!ts.isTemplateExpression(node)) return node.text;
    let text = node.head.text;
    for (const span of node.templateSpans) {
      if (!ts.isIdentifier(span.expression)) throw new Error(`${name} interpolates a non-constant`);
      text += resolve(span.expression.text, new Set(seen)) + span.literal.text;
    }
    return text;
  };
  return resolve;
}

function evaluatedLiteral(source, clause) {
  let result = null;
  const visit = (node) => {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === clause) {
      const inner = (child) => {
        if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) && child.expression.name.text === "evaluate" &&
            child.arguments.length === 1 && ts.isStringLiteral(child.arguments[0])) result = child.arguments[0].text;
        ts.forEachChild(child, inner);
      };
      inner(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (result === null) throw new Error(`no evaluate literal under case ${clause}`);
  return result;
}

function lookCarrying(name, build) {
  const split = (look) => {
    const code = build(look);
    const json = JSON.stringify(look);
    const at = code.indexOf(json);
    if (at < 0 || at !== code.lastIndexOf(json)) throw new Error(`${name} does not carry its look exactly once`);
    return [code.slice(0, at), code.slice(at + json.length)];
  };
  const [text, suffix] = split({ dark: false, size: 0, font: READER_FONTS[0] });
  const [otherText, otherSuffix] = split({ dark: true, size: READER_SIZES.length - 1, font: READER_FONTS.at(-1) });
  if (text !== otherText || suffix !== otherSuffix || !/^[\])};]+$/.test(suffix)) throw new Error(`${name} varies outside its look`);
  return { name, text, args: "kLook", suffix };
}

function pickerCarrying(name, op, args, samples, suffix) {
  const splits = samples.map((value) => pickerHost.splitPickerCall(op, value));
  if (splits.some((split) => split.prefix !== splits[0].prefix || split.suffix !== splits[0].suffix)) throw new Error(`${name} varies outside its argument`);
  return { name, text: splits[0].prefix, args, suffix: suffix ?? splits[0].suffix };
}

function pickerOperations() {
  return [
    pickerCarrying("elementPickerStart", "start", "kPoint", [null, [10, 20]], pickerHost.PICKER_START_SUFFIX),
    { name: "elementPickerTake", text: pickerHost.PICKER_TAKE, args: "kNone", suffix: "" },
    { name: "elementPickerCancel", text: pickerCall("cancel"), args: "kNone", suffix: "" },
    pickerCarrying("elementPickerApply", "apply", "kSelectors", [[], ["#a", "div.b > p"]]),
    pickerCarrying("elementPickerUnhide", "unhide", "kSelectors", [[], ["#a", "div.b > p"]]),
  ];
}

export function pageOperations() {
  const selection = constants(parse(SELECTION));
  return [
    { name: "selectionContext", text: selection("SELECTION_CONTEXT"), args: "kNone", suffix: "" },
    { name: "hasSelection", text: selection("HAS_SELECTION"), args: "kNone", suffix: "" },
    { name: "jumpToSelection", text: selection("JUMP_TO_SELECTION"), args: "kNone", suffix: "" },
    { name: "replaceInField", text: `(${selection("REPLACE")})(`, args: "kReplace", suffix: ")" },
    { name: "selectedText", text: evaluatedLiteral(parse(COMMANDS), "useSelectionForFind"), args: "kNone", suffix: "" },
    { name: "readerCheck", text: readerPage.readerCheckCall(), args: "kNone", suffix: "" },
    { name: "readerState", text: readerPage.readerCall("state"), args: "kNone", suffix: "" },
    { name: "readerHide", text: readerPage.readerCall("hide"), args: "kNone", suffix: "" },
    lookCarrying("readerToggle", readerPage.readerToggleCall),
    lookCarrying("readerOpen", readerPage.readerOpenCall),
    lookCarrying("readerSetLook", (look) => readerPage.readerCall("setLook", look)),
    ...pickerOperations(),
  ];
}

export function pageOperationsHeader(operations = pageOperations()) {
  const rows = operations.map(({ name, text, args, suffix }) => {
    const bytes = Buffer.from(text, "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    return `    {"${name}", ${bytes.length}, "${digest}", LinuxPageOperationArgs::${args}, ${JSON.stringify(suffix)}},`;
  });
  const fonts = READER_FONTS.map((font) => JSON.stringify(font)).join(", ");
  return [
    "#ifndef ARDIA_LINUX_AC_LINUX_PAGE_OPERATIONS_H_",
    "#define ARDIA_LINUX_AC_LINUX_PAGE_OPERATIONS_H_",
    "",
    "#include <stddef.h>",
    "",
    "#include <array>",
    "#include <string_view>",
    "",
    "namespace ardiacore {",
    "",
    "enum class LinuxPageOperationArgs { kNone, kReplace, kLook, kPoint, kSelectors };",
    "",
    "struct LinuxPageOperation {",
    "  std::string_view name;",
    "  size_t length;",
    "  std::string_view sha256;",
    "  LinuxPageOperationArgs args;",
    "  std::string_view suffix;",
    "};",
    "",
    `inline constexpr int kLinuxReaderLookSizes = ${READER_SIZES.length};`,
    `inline constexpr std::array<std::string_view, ${READER_FONTS.length}> kLinuxReaderLookFonts = {{${fonts}}};`,
    "",
    `inline constexpr std::array<LinuxPageOperation, ${rows.length}> kLinuxPageOperations = {{`,
    ...rows,
    "}};",
    "",
    "}",
    "",
    "#endif",
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2];
  if (mode !== "--check" && mode !== "--write") {
    console.error(USAGE);
    process.exit(64);
  }
  const header = pageOperationsHeader();
  if (mode === "--write") writeFileSync(TABLE, header);
  else if (readFileSync(TABLE, "utf8") !== header) {
    console.error("ac_linux_page_operations.h is stale: run apps/desktop/scripts/page-operations.mjs --write");
    process.exit(1);
  }
}
