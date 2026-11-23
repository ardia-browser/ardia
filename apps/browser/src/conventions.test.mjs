import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCEPTED_RISK_LISTS,
  annotationSkipMarkers,
  helpExempt,
  jsSkipMarkers,
  jsSleeps,
  listMarkers,
  powershellSleeps,
  pythonSkipMarkers,
  pythonSleeps,
  resolveMarker,
  shellSleeps,
  swiftSkipMarkers,
} from "../scripts/conventions/houseRules.mjs";
import { embeddedToSource, scanHashSimple, scanMarkup, scanPowerShell, scanPython, scanShell, scanYaml } from "../scripts/conventions/scanners.mjs";

const LAYER_FOLDERS = [
  ["components/ui/", "ui"],
  ["components/", "components"],
  ["state/", "state"],
  ["platform/", "platform"],
  ["lib/", "lib"],
];
const ENTRY_FILES = ["App", "main"];
const MAY_IMPORT = {
  app: ["app", "components", "ui", "state", "platform", "lib"],
  components: ["components", "ui", "state", "lib"],
  ui: ["ui", "lib"],
  state: ["state", "platform", "lib"],
  platform: ["platform", "lib"],
  lib: ["lib"],
};
const MAY_CALL_NATIVE = ["platform", "ui"];
const HANDS_PLATFORM_TO_SCRIPTS = new Set(["components/dev/devHarness.ts"]);

const RULES = ["layout", "imports", "native-calls", "tokens", "scale", "get-state", "set-state", "store-reads", "store-shape", "native-loops", "size", "env", "naming", "comments", "file-names", "bare-sleep", "expiring-skip"];
const SIZE_CAP = { js: 400, native: 600 };
const GENERATED = new Set(["packages/core/src/bangList.ts", "packages/demo/src/shims/web/symbols/data.ts", "apps/browser/src/lib/emojiData.ts", "packages/phone/ios/ArdiaKit/Sources/ArdiaShared/Scripts/ardia-core.js", "packages/phone/ios/ArdiaKit/Sources/ArdiaShared/Scripts/ardia-sync.js"]);
const ONE_INJECTED_SCRIPT = new Set(["packages/ardiacore/ios/page_script.js"]);
const FROZEN_SPECS = new Set(["packages/core/src/suggest.reference.ts"]);
const LAUNCH_CONFIG = [/^packages\/ardiacore\/ios\/ArdiaLaunchConfig\.\w+$/, /^apps\/browser\/src\/platform\/launchConfig\.ts$/];
const MIGRATION_FILE = /(?:^|\/)(?:LegacyMigration\.swift|legacy\.ts|\w*[Mm]igrations?\.(?:ts|swift|mm|m))$/;
const TOKEN_FILE = /(?:^|\/)(?:tokens|motion)\.ts$/;
const ENGINE_ENV_READS = {
  "engine/ardiacore/src/ardia/core/ac_main_delegate.cc": [
    "std::string EnvironmentThatOpensTheProfile(base::Environment& env) {",
    "std::unique_ptr<base::Environment> env = base::Environment::Create();",
  ],
  "engine/chromium/src/chrome/browser/ardia/ac_scripts_policy.cc": ['if (const char* home = getenv("HOME")) {'],
};

const APP_SRC = "apps/browser/src/";
const BASELINE_PATH = `${APP_SRC}conventions-baseline.json`;
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const SOURCE_FILE = /\.(?:tsx?|mjs|js|swift|h|m|mm|cc|mojom)$/;
const SCOPE_FILE = /^(?:apps\/browser\/src\/|packages\/[^/]+\/(?:src|ios)\/|engine\/(?:ardiacore|chromium)\/src\/)/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$|(?:^|\/)(?:test-native|fixtures|tests|Tests)\/|(?:^|\/)test-(?:loader|hooks)\.mjs$/;

const TOOL_DIRECTIVE =
  /^(?:\/\/+|\/\*+)\s*(?:@ts-(?:expect-error|ignore|nocheck|check)|eslint-(?:disable|enable|env)|swiftlint:|swift-format-ignore|swift-tools-version:|prettier-ignore|clang-format (?:on|off)|NOLINT|nogncheck|IWYU pragma|[#@]__PURE__|# sourceURL=|# sourceMappingURL=|<reference\s|@jsxImportSource\s|@vite-ignore|webpack\w+:|stylelint-(?:disable|enable)|ktlint-(?:disable|enable)|@formatter:(?:on|off)|noinspection\s|biome-ignore|(?:c8|v8|istanbul) ignore\b)|^\/\*\*\s*@(?:type|satisfies)\s*\{.*\}\s*\*\/$|^\/\*\s*globals?\s+[\w$,\s]+\*\/$/;
const HASH_DIRECTIVE =
  /^#\s*(?:shellcheck\s|noqa\b|type:\s|pyright:|mypy:|pylint:|ruff:|fmt:\s*(?:on|off|skip)|isort:|nosec\b|pragma:?\s|yaml-language-server:|zizmor:|actionlint\b|syntax=|escape=|check=|requires\s+-|frozen_string_literal:|-\*-|vim?:|coding[:=]|rubocop:|cspell:|codespell:)/i;
const MARKUP_DIRECTIVE = /^<!--\s*(?:prettier-ignore|htmlhint\s|eslint-|markdownlint-)/;
const LICENSE_HEADER = /copyright|licen[cs]e|spdx|\b(?:MIT|ISC|Apache-2\.0|BSD-[23]-Clause|MPL-2\.0)\b/i;
const NESTED_COMMENTS = new Set(["swift", "kotlin", "rust"]);
const RUST_RAW_STRING = /b?r(#*)"/y;
const C_FAMILY = new Set(["js", "swift", "c", "kotlin", "rust", "css"]);
const REGEX_AFTER_WORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);

function scanSource(src, lang, embedded = false, codeInStrings = true) {
  const n = src.length;
  const comments = [];
  const strings = [];
  let i = 0;
  let regexOk = true;

  const lineComment = () => {
    const start = i;
    while (i < n && src[i] !== "\n") i++;
    comments.push([start, i]);
  };
  const blockComment = () => {
    const start = i;
    if (NESTED_COMMENTS.has(lang)) {
      let depth = 0;
      while (i < n) {
        if (src.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (src.startsWith("*/", i)) {
          depth--;
          i += 2;
          if (!depth) break;
        } else i++;
      }
    } else {
      const end = src.indexOf("*/", i + 2);
      if (end < 0 && embedded) return false;
      i = end < 0 ? n : end + 2;
    }
    comments.push([start, i]);
    return true;
  };
  const quoted = (quote, multiline = false) => {
    const start = ++i;
    while (i < n && src[i] !== quote && (multiline || src[i] !== "\n")) i += src[i] === "\\" ? 2 : 1;
    strings.push({ start, end: Math.min(i, n), embedded: false, holes: [] });
    i++;
  };
  const delimited = (open, close) => {
    const start = i + open;
    const end = src.indexOf(close, start);
    const stop = end < 0 ? n : end;
    strings.push({ start, end: stop, embedded: false, holes: [] });
    i = stop + close.length;
  };
  const rawCString = () => {
    const open = src.indexOf("(", i);
    const delimiter = src.slice(i + 1, open);
    const close = `)${delimiter}"`;
    const start = open + 1;
    const end = src.indexOf(close, start);
    const stop = end < 0 ? n : end;
    strings.push({ start, end: stop, embedded: true, holes: [] });
    i = stop + close.length;
  };
  const template = () => {
    const start = ++i;
    const holes = [];
    while (i < n && src[i] !== "`") {
      if (src[i] === "\\") {
        i += 2;
      } else if (src[i] === "$" && src[i + 1] === "{") {
        const hole = i;
        i += 2;
        code("}");
        i++;
        holes.push([hole, i]);
      } else i++;
    }
    strings.push({ start, end: Math.min(i, n), embedded: true, holes });
    i++;
  };
  const swiftString = () => {
    let hashes = 0;
    while (src[i] === "#") {
      hashes++;
      i++;
    }
    const multiline = src.startsWith('"""', i);
    i += multiline ? 3 : 1;
    const start = i;
    const close = (multiline ? '"""' : '"') + "#".repeat(hashes);
    const escape = "\\" + "#".repeat(hashes);
    const holes = [];
    while (i < n) {
      if (src.startsWith(escape, i)) {
        const after = i + escape.length;
        if (src[after] === "(") {
          const hole = i;
          i = after + 1;
          code(")");
          i++;
          holes.push([hole, i]);
        } else i = after + 1;
        continue;
      }
      if (src.startsWith(close, i) || (!multiline && src[i] === "\n")) break;
      i++;
    }
    strings.push({ start, end: Math.min(i, n), embedded: multiline, holes });
    i += src.startsWith(close, i) ? close.length : 1;
  };
  const regex = () => {
    i++;
    let inClass = false;
    while (i < n && src[i] !== "\n") {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      i++;
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) break;
    }
    while (i < n && /[a-z]/.test(src[i])) i++;
  };
  const code = (closer) => {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      const next = src[i + 1];
      if (lang !== "css" && c === "/" && next === "/" && (embedded ? /^$|[\s;{}(),]/.test(src[i - 1] ?? "") : src[i - 1] !== ":")) {
        lineComment();
        continue;
      }
      if (c === "/" && next === "*" && blockComment()) continue;
      if (lang === "kotlin" && src.startsWith('"""', i)) {
        delimited(3, '"""');
        continue;
      }
      if (lang === "rust") {
        RUST_RAW_STRING.lastIndex = i;
        const raw = RUST_RAW_STRING.exec(src);
        if (raw && !/[\w$]/.test(src[i - 1] ?? "")) {
          delimited(raw[0].length, `"${raw[1]}`);
          continue;
        }
        if (c === '"') {
          quoted('"', true);
          continue;
        }
        if (c === "'") {
          if (src[i + 1] === "\\" || src[i + 2] === "'") quoted("'");
          else i++;
          continue;
        }
      }
      if (lang === "swift") {
        if (c === '"' || (c === "#" && /^#+"/.test(src.slice(i, i + 8)))) {
          swiftString();
          continue;
        }
      } else if (c === '"' || c === "'") {
        if (lang === "c" && c === '"' && /(?:^|[^\w])(?:u8|u|U|L)?R$/.test(src.slice(Math.max(0, i - 4), i))) rawCString();
        else quoted(c);
        regexOk = false;
        continue;
      } else if (lang === "js" && c === "`") {
        template();
        regexOk = false;
        continue;
      } else if (lang === "js" && c === "/") {
        if (regexOk && !closesJsxTag(src, i)) {
          regex();
          regexOk = false;
        } else {
          i++;
          regexOk = true;
        }
        continue;
      }
      if (/[\w$]/.test(c)) {
        const start = i;
        while (i < n && /[\w$]/.test(src[i])) i++;
        regexOk = REGEX_AFTER_WORDS.has(src.slice(start, i));
        continue;
      }
      if (closer && depth === 0 && c === closer) return;
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      if (!/\s/.test(c)) regexOk = !(c === ")" || c === "]" || c === "}" || (c === ">" && src[i - 1] !== "="));
      i++;
    }
  };

  code(null);
  const codeAndStrings = blank(src, comments);
  const firstCode = codeAndStrings.search(/\S/);
  const header = comments.filter(([, end]) => firstCode < 0 || end <= firstCode);
  const licensed = header.some(([start, end]) => LICENSE_HEADER.test(src.slice(start, end)));
  const stray = comments.filter(
    (range) => !(licensed && header.includes(range)) && !TOOL_DIRECTIVE.test(src.slice(range[0], range[1])),
  );
  for (const s of strings) {
    if (!s.embedded || !codeInStrings) continue;
    const text = withoutHoles(src, s).replace(/\\([\s\S])/g, (_, ch) => (ch === "\\" ? "  " : ` ${ch}`));
    for (const [start, end] of scanSource(text, "js", true).stray) stray.push([s.start + start, s.start + end]);
  }
  return { comments, strings, stray, codeAndStrings };
}

function closesJsxTag(src, slash) {
  let before = slash - 1;
  while (before >= 0 && /\s/.test(src[before])) before--;
  return src[before] === "<";
}

function withoutHoles(src, { start, end, holes }) {
  let text = "";
  let at = start;
  for (const [holeStart, holeEnd] of holes) {
    text += src.slice(at, holeStart) + src.slice(holeStart, holeEnd).replace(/[^\n]/g, "0");
    at = holeEnd;
  }
  return text + src.slice(at, end);
}

const HEX_STRING = /^(["'`])([0-9a-f]{3,8})\1$/i;
const HEX_BINDING = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(["'`])([0-9a-f]{3,8})\2/gi;

function hexBindings(code) {
  return new Map([...code.matchAll(HEX_BINDING)].map((match) => [match[1], match[3]]));
}

function withHexHoles(src, { start, end, holes }, bindings) {
  let text = "";
  let at = start;
  for (const [holeStart, holeEnd] of holes) {
    const inner = src.slice(holeStart + 2, holeEnd - 1).trim();
    const hex = inner.match(HEX_STRING)?.[2] ?? bindings.get(inner);
    text += src.slice(at, holeStart) + (hex ?? src.slice(holeStart, holeEnd).replace(/[^\n]/g, "_"));
    at = holeEnd;
  }
  return text + src.slice(at, end);
}

function blank(src, ranges) {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  for (const [start, end] of sorted) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    out += src.slice(at, from) + src.slice(from, end).replace(/[^\n]/g, " ");
    at = end;
  }
  return out + src.slice(at);
}

function stringContentRanges({ start, end, holes }) {
  const ranges = [];
  let at = start;
  for (const [holeStart, holeEnd] of holes) {
    ranges.push([at, holeStart]);
    at = holeEnd;
  }
  ranges.push([at, end]);
  return ranges;
}

const LANGUAGES = [
  [/\.(?:[cm]?[jt]sx?)$|(?:^|\/)(?:tsconfig[\w.-]*|jsconfig)\.json$|\.jsonc$/, "js"],
  [/\.swift$/, "swift"],
  [/\.(?:h|hh|hpp|c|cc|cpp|m|mm|mojom|java)$/, "c"],
  [/\.(?:kts?|gradle)$/, "kotlin"],
  [/\.rs$/, "rust"],
  [/\.css$/, "css"],
  [/\.(?:sh|bash|zsh)$/, "shell"],
  [/\.ps[dm]?1$/, "powershell"],
  [/\.py$/, "python"],
  [/\.ya?ml$/, "yaml"],
  [/\.toml$/, "toml"],
  [/\.gni?$/, "gn"],
  [/(?:^|\/)(?:Podfile|Gemfile|Fastfile|Brewfile)$|\.(?:rb|podspec)$/, "ruby"],
  [/(?:^|\/)Dockerfile(?:\.[\w-]+)?$/, "docker"],
  [/\.html?$/, "html"],
  [/\.astro$/, "astro"],
  [/\.xml$/, "xml"],
];
const SHEBANG_LANGUAGES = [
  [/^#!.*\b(?:ba|z|da|k)?sh\b/, "shell"],
  [/^#!.*\bpython[\d.]*\b/, "python"],
  [/^#!.*\b(?:node|bun|deno)\b/, "js"],
  [/^#!.*\bpwsh\b/, "powershell"],
  [/^#!.*\bruby\b/, "ruby"],
];
const EXTENSIONLESS = /(?:^|\/)[^/.]+$/;

function languageOf(path, src = "") {
  for (const [pattern, lang] of LANGUAGES) if (pattern.test(path)) return lang;
  if (EXTENSIONLESS.test(path) && src.startsWith("#!")) {
    const shebang = src.slice(0, src.indexOf("\n") >>> 0);
    for (const [pattern, lang] of SHEBANG_LANGUAGES) if (pattern.test(shebang)) return lang;
  }
  return null;
}

function layerOf(rel) {
  for (const [prefix, layer] of LAYER_FOLDERS) if (rel.startsWith(prefix) || rel === prefix.slice(0, -1)) return layer;
  if (ENTRY_FILES.includes(rel.replace(/\.(?:tsx?|mjs|js)$/, ""))) return "app";
  return null;
}

const count = (text, pattern) => (text.match(pattern) || []).length;

const COLOR_LITERAL = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\s*\(/gi;
const NAMED_CLEAR = /^\s*transparent\s*$/i;
const JS_RESTARTED_LOOP = /\bAnimated\s*\.\s*loop\s*\(\s*Animated\s*\.\s*(?:sequence|parallel|stagger)\s*\(/g;
const MOTION_LITERAL = /\bEasing\s*\.\s*\w|\bduration\s*:\s*-?\.?\d|\bAnimated\s*\.\s*delay\s*\(\s*\d/g;
const SCALE_PROPERTY =
  /(?<![\w$.])(?:fontSize|letterSpacing|radius|[a-z]\w*Radius|padding(?:Horizontal|Vertical|Top|Bottom|Left|Right|Start|End)?|margin(?:Horizontal|Vertical|Top|Bottom|Left|Right|Start|End)?|gap|rowGap|columnGap|damping|stiffness|friction|tension|bounciness)\s*(?::|=\s*\{|=(?![=>]))/g;
const NUMBER = String.raw`-?\s*(?:\d+(?:\.\d+)?|\.\d+)(?![\w.$])`;
const LEADING_NUMBER = new RegExp(String.raw`^\(?\s*(${NUMBER})`);
const NUMERIC_BRANCH = new RegExp(String.raw`[?:]\s*(${NUMBER})\s*(?=:|\)|$)`, "g");
const ENV_READ =
  /\b(?:secure_)?getenv\s*\(|processInfo(?:\]\s*|\s*\.\s*)environment\b|ProcessInfo\s*\(\s*\)\s*\.\s*environment\b|\bprocess\s*\.\s*env\b|\bbase::Environment\b/g;
const CEF_NAME = /(?<![A-Za-z])(?:[Cc]ef|CEF)(?![a-z])|(?<=[a-z0-9_])(?:Cef|CEF)(?![a-z])/g;
const LEGACY_BRAND = /netnyahoo/gi;
const LEGACY_PREFIX = /\bNN[A-Z][a-z]\w*/g;
const APP_SIDE_OBJC_FILE = /^(?:AC[A-Z]|ArdiaCore[A-Z])\w*\.(?:h|m|mm|swift)$/;
const APP_SIDE_OBJC_CLASS =
  /@(?:interface|implementation|protocol)\s+(?:AC[A-Z]|ArdiaCore[A-Z])\w*\b(?!\s*[(;])|(?<!@)\b(?:class|struct|enum|protocol|actor|typealias)\s+(?:AC[A-Z]|ArdiaCore[A-Z])\w*|@objc\(\s*(?:AC[A-Z]|ArdiaCore[A-Z])\w*\s*\)/g;
const IMPORT_SPEC =
  /\b(?:import|export)\b[^;"'`]*?\bfrom\s*(["'])([^"'\n]+)\1|\bimport\s*(?:\(\s*)?(["'])([^"'\n]+)\3|\brequire\s*\(\s*(["'])([^"'\n]+)\5/g;
const NATIVE_PACKAGE = /^(?:@ardia\/(?:ardiacore|shell|shaders|import|sync)(?:\/.*)?|expo-modules-core)$/;
const NATIVE_GLOBAL = /\bNativeModules\b(?!\s*[,}])|\brequireNative(?:Module|Component|ViewManager)\s*\(/g;
const COMPONENT_FILE = /^[A-Z][A-Za-z0-9]*(?:\.(?:web|native|macos|ios|windows|linux|win|desktop))?\.tsx$/;
const MODULE_FILE = /^[a-z][A-Za-z0-9]*(?:\.(?:web|native|macos|ios|windows|linux|win|desktop))?\.(?:ts|mjs)$/;
const TEST_NAME = /^[A-Za-z][A-Za-z0-9]*\.test\.mjs$/;

function valueAt(code, at) {
  let depth = 0;
  let end = at;
  for (; end < code.length; end++) {
    const c = code[end];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === "," || c === ";" || c === "\n")) break;
  }
  return code.slice(at, end).trim();
}

const nonZero = (literal) => Number(literal.replace(/\s+/g, "")) !== 0;

function scaleLiterals(code) {
  let found = 0;
  for (const match of code.matchAll(SCALE_PROPERTY)) {
    const value = valueAt(code, match.index + match[0].length);
    const leading = value.match(LEADING_NUMBER);
    const branches = [...value.matchAll(NUMERIC_BRANCH)].map((branch) => branch[1]);
    if ((leading && nonZero(leading[1])) || branches.some(nonZero)) found++;
  }
  return found;
}

function unshapedStores(code) {
  let found = 0;
  for (const match of code.matchAll(/(?<![.\w$])create\s*(<|\()/g)) {
    let at = match.index + match[0].length;
    if (match[1] === "<") {
      for (let depth = 1; at < code.length && depth; at++) depth += code[at] === "<" ? 1 : code[at] === ">" ? -1 : 0;
      if (!code.startsWith("()(", at)) found++;
      else if (/^\(\)\(\s*\(\s*set\b/.test(code.slice(at, at + 40))) found++;
    } else found++;
  }
  return found;
}

function envReads(path, src, code) {
  const exempt = ENGINE_ENV_READS[path] ?? [];
  let found = 0;
  for (const match of code.matchAll(ENV_READ)) {
    const lineStart = src.lastIndexOf("\n", match.index) + 1;
    const lineEnd = src.indexOf("\n", match.index);
    if (!exempt.includes(src.slice(lineStart, lineEnd < 0 ? src.length : lineEnd).trim())) found++;
  }
  return found;
}

const HASH_SCANNERS = {
  shell: scanShell,
  powershell: scanPowerShell,
  python: scanPython,
  yaml: scanYaml,
  toml: (src) => scanHashSimple(src, "toml"),
  gn: (src) => scanHashSimple(src, "gn"),
  ruby: (src) => scanHashSimple(src, "ruby"),
  docker: (src) => scanHashSimple(src, "docker"),
};

function directiveOf(lang) {
  if (C_FAMILY.has(lang)) return TOOL_DIRECTIVE;
  if (lang === "html" || lang === "astro" || lang === "xml") return MARKUP_DIRECTIVE;
  return HASH_DIRECTIVE;
}

const EXECUTABLE_YAML = /^\.github\/workflows\/[^/]+\.ya?ml$|(?:^|\/)action\.ya?ml$/;

function scanFile(src, lang, { embedded = false, codeInStrings = true, helpPrinters = new Set(), path = "" } = {}) {
  if (C_FAMILY.has(lang)) {
    const scanned = scanSource(src, lang, false, codeInStrings);
    const code = blank(scanned.codeAndStrings, scanned.strings.flatMap(stringContentRanges));
    const exempt = embedded ? () => false : helpExempt(lang, src, scanned, helpPrinters);
    return { ...scanned, stray: scanned.stray.filter((range) => !exempt(range)), code, parts: [{ lang, src, code, codeAndStrings: scanned.codeAndStrings, strings: scanned.strings }] };
  }
  const isMarkup = lang === "html" || lang === "astro" || lang === "xml";
  const scanned = isMarkup ? scanMarkup(src, lang) : lang === "yaml" ? scanYaml(src, { executable: EXECUTABLE_YAML.test(path) }) : HASH_SCANNERS[lang](src);
  const commentRanges = lang === "python" ? [...scanned.comments, ...scanned.docstrings] : scanned.comments;
  const codeAndStrings = blank(src, commentRanges);
  const code = blank(codeAndStrings, scanned.strings.map((s) => [s.start, s.end]));
  const exempt = embedded ? () => false : helpExempt(lang, src, { ...scanned, code, codeAndStrings }, helpPrinters);
  const shebang = src.startsWith("#!") ? [[0, src.indexOf("\n") >>> 0]] : [];
  const firstCode = embedded ? -1 : blank(codeAndStrings, shebang).search(/\S/);
  const header = commentRanges.filter(([, end]) => firstCode < 0 || end <= firstCode);
  const licensed = !embedded && header.some(([start, end]) => LICENSE_HEADER.test(src.slice(start, end)));
  const directive = directiveOf(lang);
  const stray = commentRanges.filter(
    (range) => !exempt(range) && !(licensed && header.includes(range)) && !directive.test(src.slice(range[0], range[1]).trim()),
  );
  const parts = isMarkup ? [] : [{ lang, src, code, codeAndStrings, strings: scanned.strings }];
  for (const part of scanned.embedded ?? []) {
    const inner = scanFile(part.text, part.lang, { embedded: true });
    for (const [start, end] of inner.stray) stray.push([embeddedToSource(part, start), embeddedToSource(part, end)]);
    parts.push(...inner.parts);
  }
  return { strings: scanned.strings, stray, codeAndStrings, code, parts };
}

const SLEEP_COUNTERS = {
  shell: (part) => shellSleeps(part.code),
  powershell: (part) => powershellSleeps(part.code),
  python: (part) => pythonSleeps(part.code),
};
const SKIP_HINT = /\b(?:skip|todo|only|disabled|ignore|Ignore|Disabled|xfail|expectedFailure)\b/;
const NO_SLEEP_RULE = /^(?:infra\/|scripts\/agent\/await$)/;
const HOUSE_TEST_FILE = /(?:^|\/)(?:test|androidTest|tests?)\/|(?:^|\/)test_[^/]*\.py$|_test\.py$/;

function skipMarkers(path, src, lang, parts) {
  if (ACCEPTED_RISK_LISTS.includes(path)) return listMarkers(path, src).map((marker) => resolveMarker(src, marker));
  if (!lang || !SKIP_HINT.test(src)) return [];
  const isTest = TEST_FILE.test(path) || HOUSE_TEST_FILE.test(path);
  const markers = [];
  for (const part of parts) {
    if (part.src !== src) continue;
    if (lang === "js" && isTest) markers.push(...jsSkipMarkers(src, part.code, part.strings, part.codeAndStrings));
    else if (lang === "python") markers.push(...pythonSkipMarkers(src, part.code, part.strings));
    else if (lang === "swift") markers.push(...swiftSkipMarkers(src, part.code, part.strings));
    else if (lang === "rust" || ((lang === "kotlin" || (lang === "c" && path.endsWith(".java"))) && isTest)) markers.push(...annotationSkipMarkers(src, part.code, part.strings, lang));
  }
  return markers.map((marker) => resolveMarker(src, marker));
}

function houseRules(path, src, lang, parts, add, markers) {
  if (CHECKER_FILES.has(path)) return;
  if (!NO_SLEEP_RULE.test(path)) {
    const isTest = TEST_FILE.test(path);
    let sleeps = 0;
    for (const part of parts) {
      if (part.lang === "js") sleeps += isTest && part.src === src ? jsSleeps(part.code, part.codeAndStrings) : 0;
      else sleeps += SLEEP_COUNTERS[part.lang]?.(part) ?? 0;
    }
    add("bare-sleep", path, sleeps);
  }
  const found = skipMarkers(path, src, lang, parts);
  add("expiring-skip", path, found.filter((marker) => !marker.date).length);
  markers?.push(...found.filter((marker) => marker.date || marker.never || marker.invalid).map((marker) => ({ ...marker, path })));
}

const GENERATED_MARK = /^(?:#!.*\n)?\W{0,4}(?:@generated|(?:auto-?)?generated (?:by|from|with)\b|do not edit\b)/i;
const SOURCES_HELP = /^\s*(?:source|\.)\s+[^\n;]*?([\w.-]+\.sh)\b/gm;
const PRINTS_CALLERS_HEADER = /\b(?:sed|head|awk|grep|tail)\b[^\n]*["']?\$0\b/;

function helpPrintersOf(files) {
  const printers = new Set();
  for (const [path, src] of files) if (/\.sh$/.test(path) && !src.startsWith("#!") && PRINTS_CALLERS_HEADER.test(src)) printers.add(posix.basename(path));
  return printers;
}

const isGenerated = (path, src) => !inStructuralScope(path) && GENERATED_MARK.test(src.slice(0, 300));

function checkFile(path, src, add, markers, helpPrinters = new Set()) {
  const lang = languageOf(path, src);
  const structural = inStructuralScope(path);
  if (lang && isGenerated(path, src)) return;
  if (!lang) {
    if (ACCEPTED_RISK_LISTS.includes(path)) houseRules(path, src, null, [], add, markers);
    return;
  }
  const isTest = TEST_FILE.test(path);
  const isDeclaration = path.endsWith(".d.ts");
  const inApp = path.startsWith(APP_SRC);
  const rel = inApp ? path.slice(APP_SRC.length) : path;
  const base = posix.basename(path);
  const sourced = new Set([...src.matchAll(SOURCES_HELP)].map((match) => match[1]).filter((name) => helpPrinters.has(name)));
  const { strings, stray, codeAndStrings, code, parts } = scanFile(src, lang, { codeInStrings: structural, helpPrinters: sourced, path });
  add("comments", path, stray.length);
  houseRules(path, src, lang, parts, add, markers);
  if (!structural) return;

  if (isTest || isDeclaration) {
    if (inApp && isTest && base.endsWith(".test.mjs") && !TEST_NAME.test(base)) add("file-names", path, 1);
    return;
  }

  const lines = src.length ? src.split("\n").length - (src.endsWith("\n") ? 1 : 0) : 0;
  const isJs = /\.tsx?$/.test(path) && (inApp || /^packages\/[^/]+\/src\//.test(path)) && !FROZEN_SPECS.has(path);
  const isNative = /\.(?:swift|h|m|mm|cc|mojom|js)$/.test(path) && !ONE_INJECTED_SCRIPT.has(path);
  if ((isJs && lines > SIZE_CAP.js) || (isNative && lines > SIZE_CAP.native)) add("size", path, 1);
  if (isJs) add("native-loops", path, count(code, JS_RESTARTED_LOOP));

  if (!LAUNCH_CONFIG.some((allowed) => allowed.test(path))) add("env", path, envReads(path, src, code));

  let naming = count(codeAndStrings, CEF_NAME);
  if (!MIGRATION_FILE.test(path)) naming += count(codeAndStrings, LEGACY_BRAND) + count(code, LEGACY_PREFIX);
  if (/^packages\/[^/]+\/ios\//.test(path)) naming += (APP_SIDE_OBJC_FILE.test(base) ? 1 : 0) + count(code, APP_SIDE_OBJC_CLASS);
  add("naming", path, naming);

  if (!inApp || !/\.(?:tsx?|mjs)$/.test(path)) return;

  if (!(COMPONENT_FILE.test(base) || MODULE_FILE.test(base) || rel === "main.tsx")) add("file-names", path, 1);

  if (!TOKEN_FILE.test(path)) {
    const bindings = hexBindings(codeAndStrings);
    const colors = strings.reduce((sum, s) => sum + count(withHexHoles(src, s, bindings), COLOR_LITERAL) + (NAMED_CLEAR.test(src.slice(s.start, s.end)) ? 1 : 0), 0);
    add("tokens", path, colors + count(code, MOTION_LITERAL));
    if (rel.startsWith("components/") || rel === "App.tsx") add("scale", path, scaleLiterals(code));
  }

  if (rel.startsWith("components/")) {
    add("get-state", path, count(code, /\bgetState\s*\(/g));
    add("set-state", path, count(code, /\.setState\s*\(/g));
    add("store-reads", path, count(code, /\buseBrowser\s*\(/g));
  }
  if (/\bimport\s*\{[^}]*\bcreate\b[^}]*\}\s*from\s*["']zustand["']/.test(codeAndStrings)) add("store-shape", path, unshapedStores(code));

  const layer = layerOf(rel);
  let nativeCalls = count(code, NATIVE_GLOBAL);
  let badImports = 0;
  for (const match of codeAndStrings.matchAll(IMPORT_SPEC)) {
    const spec = match[2] ?? match[4] ?? match[6];
    if (NATIVE_PACKAGE.test(spec)) {
      nativeCalls++;
      continue;
    }
    if (!layer || !spec.startsWith(".")) continue;
    const target = posix.normalize(posix.join(posix.dirname(rel), spec));
    if (target.startsWith("..")) continue;
    const targetLayer = layerOf(target);
    const handsPlatformToScripts = targetLayer === "platform" && HANDS_PLATFORM_TO_SCRIPTS.has(rel);
    if (!targetLayer || !(MAY_IMPORT[layer].includes(targetLayer) || handsPlatformToScripts)) badImports++;
  }
  if (!MAY_CALL_NATIVE.includes(layer)) add("native-calls", path, nativeCalls);
  if (!layer) add("layout", path, 1);
  else add("imports", path, badImports);
}

function git(args, input) {
  const result = spawnSync("git", args, { cwd: ROOT, input, maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

const CONVENTIONS_TEST = posix.join(APP_SRC, "conventions.test.mjs");
const CHECKER_FILES = new Set([CONVENTIONS_TEST, "apps/browser/scripts/conventions/houseRules.mjs", "apps/browser/scripts/conventions/scanners.mjs"]);
const NOT_OURS = [
  /(?:^|\/)node_modules\//,
  /(?:^|\/)(?:pnpm-lock\.yaml|[\w-]+\.lock|gradlew(?:\.bat)?)$/,
  /^packages\/ardiacore\/src\/engine\/generated\//,
  /(?:^|\/)fixtures\//,
];

const inStructuralScope = (path) => SCOPE_FILE.test(path) && SOURCE_FILE.test(path) && !GENERATED.has(path) && path !== CONVENTIONS_TEST;

function scannedPaths(paths) {
  const vendored = paths.filter((path) => /(?:^|\/)(?:LICEN[CS]E|COPYING)(?:\.[\w-]+)?$/.test(path) && path.includes("/")).map((path) => posix.dirname(path) + "/");
  const ours = (path) => !vendored.some((dir) => path.startsWith(dir)) && !NOT_OURS.some((pattern) => pattern.test(path)) && !GENERATED.has(path);
  return paths.filter(
    (path) =>
      inStructuralScope(path) ||
      ACCEPTED_RISK_LISTS.includes(path) ||
      (path !== CONVENTIONS_TEST && ours(path) && (languageOf(path) !== null || EXTENSIONLESS.test(path))),
  );
}

function workingTreeFiles() {
  const paths = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).toString().split("\0").filter(Boolean);
  return scannedPaths([...new Set(paths)])
    .filter((path) => existsSync(ROOT + path) && lstatSync(ROOT + path).isFile())
    .map((path) => [path, readFileSync(ROOT + path, "utf8")]);
}

function committedFiles(fromHead) {
  const listing = fromHead ? ["ls-tree", "-r", "-z", "HEAD"] : ["ls-files", "-s", "-z"];
  const entries = git(listing)
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      const fields = meta.split(" ");
      return [path, fields[fromHead ? 2 : 1], fields[0]];
    })
    .filter(([, , mode]) => mode !== "120000")
  const wanted = new Set(scannedPaths(entries.map(([path]) => path)));
  const picked = entries.filter(([path]) => wanted.has(path));
  const batch = git(["cat-file", "--batch"], picked.map(([, sha]) => sha).join("\n") + "\n");
  const files = [];
  let at = 0;
  for (const [path] of picked) {
    const headerEnd = batch.indexOf(10, at);
    const size = Number(batch.toString("utf8", at, headerEnd).split(" ")[2]);
    files.push([path, batch.toString("utf8", headerEnd + 1, headerEnd + 1 + size)]);
    at = headerEnd + 1 + size + 1;
  }
  return files;
}

function findViolations(files, markers = null) {
  const found = Object.fromEntries(RULES.map((rule) => [rule, {}]));
  const add = (rule, path, n) => {
    if (n > 0) found[rule][path] = (found[rule][path] ?? 0) + n;
  };
  const helpPrinters = helpPrintersOf(files);
  for (const [path, src] of files) checkFile(path, src, add, markers, helpPrinters);
  return found;
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

function breaches(markers) {
  return markers
    .filter((marker) => marker.never || marker.invalid)
    .map((marker) =>
      marker.never
        ? `  ${marker.path}:${marker.line} .only, which never belongs in a commit`
        : `  ${marker.path}:${marker.line} ${marker.kind} until ${marker.invalid}, which isn't a date (YYYY-MM-DD) with an @owner`,
    );
}

function lapsed(markers, today) {
  return markers
    .filter((marker) => !marker.never && !marker.invalid && marker.date < today)
    .map((marker) => ({ path: marker.path, line: marker.line, text: `${marker.kind} for @${marker.owner} expired ${marker.date}: fix it, or move the date with the owner's OK` }));
}

const annotation = ({ path, line, text }) => `::warning file=${path},line=${line}::${text}`;

function expirySummary(failing, warnings) {
  const lines = ["## Expiring skips", ""];
  if (!failing.length && !warnings.length) lines.push("Every dated skip, todo, quarantine and accepted risk is in date.");
  if (warnings.length) lines.push("Past their date (a warning, not a failure):", "", ...warnings.map(({ path, line, text }) => `- \`${path}:${line}\` ${text}`), "");
  if (failing.length) lines.push("Failing (`.only`, or a date that isn't one):", "", ...failing.map((entry) => `- \`${entry.trim()}\``), "");
  return lines.join("\n") + "\n";
}

const sorted = (found) =>
  Object.fromEntries(RULES.map((rule) => [rule, Object.fromEntries(Object.entries(found[rule] ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)))]));
const total = (entries = {}) => Object.values(entries).reduce((sum, n) => sum + n, 0);

function compare(baseline, found) {
  const problems = [];
  for (const rule of RULES) {
    const lines = [];
    const paths = new Set([...Object.keys(baseline[rule] ?? {}), ...Object.keys(found[rule])]);
    for (const path of [...paths].sort()) {
      const was = baseline[rule]?.[path] ?? 0;
      const now = found[rule][path] ?? 0;
      if (now > was) lines.push(`  new    ${path}: ${now}${was ? ` (baseline ${was})` : ""}`);
      else if (now < was) lines.push(`  fixed  ${path}: ${now} (baseline ${was}), lower or remove its baseline entry`);
    }
    if (lines.length) problems.push(`${rule} (${lines.length})`, ...lines);
  }
  return problems;
}

function scoreboard(found) {
  return RULES.map((rule) => `${rule} ${Object.keys(found[rule]).length} files / ${total(found[rule])}`).join(", ");
}

function report(found) {
  for (const rule of RULES) {
    console.log(`${rule}: ${Object.keys(found[rule]).length} files, ${total(found[rule])} violations`);
    for (const [path, n] of Object.entries(found[rule])) console.log(`  ${path}: ${n}`);
  }
}

function writeBaseline(fromHead, force) {
  const found = sorted(findViolations(committedFiles(fromHead)));
  let previous = null;
  try {
    previous = JSON.parse(git(["show", `HEAD:${BASELINE_PATH}`]).toString());
  } catch {}
  if (previous) {
    const grown = RULES.filter((rule) => rule in previous && total(found[rule]) > total(previous[rule]));
    const movedOutOfOldLayout = total(found.layout) < total(previous.layout);
    const refused = grown.filter((rule) => !(rule === "imports" && movedOutOfOldLayout));
    for (const rule of RULES) {
      const added = Object.keys(found[rule]).filter((path) => !(path in (previous[rule] ?? {})));
      console.log(`${rule}: ${total(previous[rule])} -> ${total(found[rule])}${added.length ? `, new entries: ${added.join(", ")}` : ""}`);
    }
    if (refused.length && !force) {
      console.error(`Refusing to write: ${refused.join(", ")} grew. Fix the new violations, or pass --force with the owner's OK.`);
      process.exit(1);
    }
  } else report(found);
  writeFileSync(ROOT + BASELINE_PATH, JSON.stringify(found, null, 2) + "\n");
  console.log(`Wrote ${BASELINE_PATH} from ${fromHead ? "HEAD" : "the git index"}: ${scoreboard(found)}`);
}

const fromHead = process.argv.includes("--from-head");
if (process.argv.includes("--expired")) {
  const markers = [];
  findViolations(workingTreeFiles().filter(([path, src]) => ACCEPTED_RISK_LISTS.includes(path) || SKIP_HINT.test(src)), markers);
  const failing = breaches(markers);
  const warnings = lapsed(markers, todayUtc());
  for (const warning of warnings) console.log(annotation(warning));
  if (failing.length) console.log(`Failing, .only or a date that isn't one:\n${failing.join("\n")}`);
  if (!failing.length && !warnings.length) console.log(`No skip, todo, quarantine or accepted risk is past its date (${markers.length} dated).`);
  const summaryAt = process.argv.indexOf("--summary");
  if (summaryAt >= 0 && process.argv[summaryAt + 1]) appendFileSync(process.argv[summaryAt + 1], expirySummary(failing, warnings));
  process.exitCode = failing.length ? 1 : 0;
} else if (process.argv.includes("--write-baseline")) {
  writeBaseline(fromHead, process.argv.includes("--force"));
} else if (process.argv.includes("--show")) {
  const helpPrinters = helpPrintersOf(workingTreeFiles());
  for (const path of process.argv.slice(process.argv.indexOf("--show") + 1)) {
    const src = readFileSync(ROOT + path, "utf8");
    const lang = languageOf(path, src);
    if (!lang || isGenerated(path, src)) continue;
    const sourced = new Set([...src.matchAll(SOURCES_HELP)].map((match) => match[1]).filter((name) => helpPrinters.has(name)));
    for (const [start, end] of scanFile(src, lang, { codeInStrings: inStructuralScope(path), helpPrinters: sourced, path }).stray) {
      const line = src.slice(0, start).split("\n").length;
      console.log(`${path}:${line}: ${src.slice(start, end).split("\n")[0].slice(0, 160)}`);
    }
  }
} else if (process.argv.includes("--report")) {
  const found = sorted(findViolations(fromHead ? committedFiles(true) : workingTreeFiles()));
  report(found);
  const problems = compare(JSON.parse(readFileSync(ROOT + BASELINE_PATH, "utf8")), found);
  console.log(problems.length ? `\nAgainst the baseline:\n${problems.join("\n")}` : "\nMatches the baseline.");
  process.exitCode = problems.length ? 1 : 0;
} else {
  const violationsOf = (path, src) => {
    const found = {};
    checkFile(path, src, (rule, _, n) => {
      if (n > 0) found[rule] = (found[rule] ?? 0) + n;
    });
    return found;
  };
  test("a Swift package manifest's tools version line is a compiler directive", () => {
    assert.deepEqual(violationsOf("packages/phone/ios/PhoneSync/Package.swift", "// swift-tools-version:6.2\nimport PackageDescription\n"), {});
    assert.deepEqual(violationsOf("packages/phone/ios/PhoneSync/Package.swift", "// swift-tools-version:6.2\n// a note\nimport PackageDescription\n"), { comments: 1 });
  });

  test("a closing JSX tag doesn't hide a comment after it", () => {
    assert.deepEqual(violationsOf("apps/browser/src/components/hello/Hello.tsx", "<Text>Hello</Text>; // comment\n"), { comments: 1 });
  });
  test("a closing JSX tag doesn't hide a colour after it", () => {
    assert.deepEqual(violationsOf("apps/browser/src/components/hello/Hello.tsx", '<Text>Hello</Text>; const color = "#ff0000";\n'), { tokens: 1 });
  });
  test("a transparent colour name counts as a colour literal, the word in copy doesn't", () => {
    assert.deepEqual(violationsOf("apps/browser/src/components/hello/Hello.tsx", 'const fill = selected ? theme.card : "transparent";\n'), { tokens: 1 });
    assert.deepEqual(violationsOf("apps/browser/src/components/hello/Hello.tsx", 'const copy = "A transparent toolbar";\n'), {});
  });
  test("scale literals count outside token files, layout geometry and computed values don't", () => {
    const scale = (path, body) => violationsOf(path, `${body}\n`).scale ?? 0;
    const component = "apps/browser/src/components/hello/Hello.tsx";
    assert.equal(scale(component, "<View style={{ padding: 9, gap: space.m, borderRadius: 0 }} />"), 1);
    assert.equal(scale(component, "<View style={{ width: 30, height: 30, top: 4, left: -2, flex: 1 }} />"), 0);
    assert.equal(scale(component, "<Text style={{ fontSize: 12.5, letterSpacing: 0.4, lineHeight: 17 }} />"), 2);
    assert.equal(scale(component, "<Surface cornerRadius={12} shadowRadius={size / 2} />"), 1);
    assert.equal(scale(component, "<View style={{ borderRadius: 10 * g.s, marginTop: -3.5, paddingHorizontal: PAD * 2 }} />"), 2);
    assert.equal(scale(component, "<View style={{ marginTop: active ? 4 : 0, gap: wide ? space.l : space.m }} />"), 1);
    assert.equal(scale(component, "function Plate({ radius = 7, box = 30 }: { radius?: number; box?: number }) {}"), 1);
    assert.equal(scale(component, "const LIFT = spring({ response: 0.2, damping: 0.5 });"), 1);
    assert.equal(scale(component, "Animated.spring(v, { toValue: 1, friction: 9, tension: 60 });"), 2);
    assert.equal(scale(component, "if (gap === 0 || radius !== 4) return;"), 0);
    assert.equal(scale("apps/browser/src/components/hello/tokens.ts", "export const HELLO = { padding: 9, radius: 7 };"), 0);
    assert.equal(scale("apps/browser/src/App.tsx", "<View style={{ paddingTop: 6 }} />"), 1);
    assert.equal(scale("apps/browser/src/lib/hello.ts", "export const ROW = { radius: 7 };"), 0);
  });
  test("an import of a layer's own folder maps to that layer", () => {
    assert.deepEqual(violationsOf("apps/browser/src/components/ui/Button.tsx", 'import { Box } from ".";\n'), {});
    assert.deepEqual(violationsOf("apps/browser/src/platform/launchConfig.ts", 'import { keys } from "../lib";\n'), {});
  });
  test("a store is created curried, with no set/get creator", () => {
    const store = (body) => violationsOf("apps/browser/src/state/hello/store.ts", `import { create } from "zustand";\n${body}\n`);
    assert.deepEqual(store("export const useA = create<{ a: number }>()(() => ({ a: 1 }));"), {});
    assert.deepEqual(store("export const useA = create<Record<string, number>>()(() => ({}));"), {});
    assert.deepEqual(store("export const useA = create<{ a: number }>(() => ({ a: 1 }));"), { "store-shape": 1 });
    assert.deepEqual(store("export const useA = create<{ a: number }>()((set) => ({ a: 1 }));"), { "store-shape": 1 });
    assert.deepEqual(store("export const useA = create((set) => ({ a: 1 }));"), { "store-shape": 1 });
  });
  test("a loop around a sequence, parallel or stagger counts; a loop of one timing doesn't", () => {
    const loop = (body) => violationsOf("apps/browser/src/components/hello/Pulse.tsx", `import { Animated } from "react-native";\n${body}\n`);
    assert.deepEqual(loop("Animated.loop(Animated.sequence([a, b])).start();"), { "native-loops": 1 });
    assert.deepEqual(loop("Animated.loop(\n  Animated.parallel([a, b]),\n).start();"), { "native-loops": 1 });
    assert.deepEqual(loop("Animated.loop(Animated.stagger(9, [a, b]));"), { "native-loops": 1 });
    assert.deepEqual(loop("Animated.loop(a).start();"), {});
    assert.deepEqual(loop("Animated.sequence([a, b]).start();"), {});
  });
  test("an interpolation after # in a string isn't a colour", () => {
    assert.deepEqual(violationsOf("apps/browser/src/state/hello/ids.ts", "export const id = (repo: string, n: number) => `${repo}#${n}`;\n"), {});
    assert.deepEqual(violationsOf("apps/browser/src/state/hello/ids.ts", 'export const plum = "#C07A98";\n'), { tokens: 1 });
    assert.deepEqual(violationsOf("apps/browser/src/state/hello/ids.ts", "export const anchor = (id: string) => `#${id}`;\n"), {});
  });
  test("a hex string interpolated after # is still a colour", () => {
    assert.deepEqual(violationsOf("apps/browser/src/state/hello/colors.ts", 'export const white = `#${"fff"}`;\n'), { tokens: 1 });
    assert.deepEqual(violationsOf("apps/browser/src/state/hello/colors.ts", 'const hex = "fff";\nexport const color = `#${hex}`;\n'), { tokens: 1 });
  });
  test("a forward declaration of the engine's ArdiaCore classes isn't an app-side class", () => {
    assert.deepEqual(violationsOf("packages/hello/ios/HelloWindow.h", "@class ArdiaCoreTab;\n"), {});
    assert.deepEqual(violationsOf("packages/hello/ios/HelloWindow.h", "@interface ArdiaCoreHello : NSObject\n@end\n"), { naming: 1 });
  });
  test("components neither write a store nor subscribe to the workspace store directly", () => {
    const component = (body) => violationsOf("apps/browser/src/components/hello/Hello.tsx", `${body}\n`);
    assert.deepEqual(component("useSidebarUi.setState({ hover: null });"), { "set-state": 1 });
    assert.deepEqual(component("const tab = useBrowser((s) => s.tabs[id]);"), { "store-reads": 1 });
    assert.deepEqual(component("const tab = useTab(id, (t) => t?.title);"), {});
  });
  test("components reach platform/ only through state, except the dev harness", () => {
    const imports = (path, spec) => violationsOf(path, `import { webviews } from "${spec}";\n`);
    assert.deepEqual(imports("apps/browser/src/components/find/FindBar.tsx", "../../platform/webviews"), { imports: 1 });
    assert.deepEqual(imports("apps/browser/src/components/settings/panes/Passwords.tsx", "../../../platform/importModule"), { imports: 1 });
    assert.deepEqual(imports("apps/browser/src/components/find/FindBar.tsx", "../../state/tabs/webviewHandles"), {});
    assert.deepEqual(imports("apps/browser/src/components/dev/devHarness.ts", "../../platform/webviews"), {});
    assert.deepEqual(imports("apps/browser/src/components/dev/DevPanel.tsx", "../../platform/webviews"), { imports: 1 });
    assert.deepEqual(imports("apps/browser/src/state/tabs/webviewHandles.ts", "../../platform/webviews"), {});
  });
  test("only the engine's named environment reads are exempt", () => {
    const delegate = "engine/ardiacore/src/ardia/core/ac_main_delegate.cc";
    const policy = "engine/chromium/src/chrome/browser/ardia/ac_scripts_policy.cc";
    const create = "  std::unique_ptr<base::Environment> env = base::Environment::Create();\n";
    assert.deepEqual(violationsOf(delegate, create), {});
    assert.deepEqual(violationsOf(delegate, `${create}  const char* port = getenv("PORT");\n`), { env: 1 });
    assert.deepEqual(violationsOf(policy, '    if (const char* home = getenv("HOME")) {\n'), {});
    assert.deepEqual(violationsOf(policy, '    const char* user = getenv("USER");\n'), { env: 1 });
    assert.deepEqual(violationsOf("engine/chromium/src/chrome/browser/ardia/ac_other.cc", '    if (const char* home = getenv("HOME")) {\n'), { env: 1 });
  });
  const house = (path, src) => {
    const found = violationsOf(path, src);
    return { comments: found.comments ?? 0, sleeps: found["bare-sleep"] ?? 0, skips: found["expiring-skip"] ?? 0 };
  };
  test("a shell # starts a comment only at a word start, outside quotes, heredocs and expansions", () => {
    const src = [
      "#!/bin/bash",
      "# a note",
      `echo "$#" "\${#items[@]}" 'a # b' "c # d" http://host/#frag $'e # f' $((16#ff))`,
      "echo hi # trailing",
      "cat <<'EOF'",
      "# inside a heredoc",
      "EOF",
      "x=$(echo a#b)",
      "# shellcheck disable=SC2086",
      "",
    ].join("\n");
    assert.equal(house("scripts/hello.sh", src).comments, 2);
  });
  test("the leading block a script prints as its --help is exempt, and only that block", () => {
    const sed = ["#!/bin/bash", "# Usage: hello.sh <dir>", "# Prints hello.", "", "# stray", 'case "${1:-}" in -h) sed -n \'2,/^$/p\' "$0"; exit 0 ;; esac', ""].join("\n");
    assert.equal(house("scripts/hello.sh", sed).comments, 1);
    const awk = ["#!/bin/bash", "# Usage: hello.sh", "help() {", "  awk 'NR == 1 { next } /^#/ { print; next } { exit }' \"$0\"", "}", "# stray", ""].join("\n");
    assert.equal(house("scripts/hello.sh", awk).comments, 1);
    const awkField = ["#!/bin/bash", "# Not help", "awk '{ print $0 }' list", ""].join("\n");
    assert.equal(house("scripts/hello.sh", awkField).comments, 1);
    const silent = ["#!/bin/bash", "# Not help", 'head -n 2 "$0" >/dev/null', ""].join("\n");
    assert.equal(house("scripts/hello.sh", silent).comments, 1);
    const echoed = ["#!/bin/bash", "# Not help", 'echo head "$0"', ""].join("\n");
    assert.equal(house("scripts/hello.sh", echoed).comments, 1);
    const length = ["#!/usr/bin/env node", "// Not help", 'import { readFileSync } from "node:fs";', 'console.log(readFileSync(new URL(import.meta.url), "utf8").length);', ""].join("\n");
    assert.equal(house("scripts/hello.mjs", length).comments, 1);
    const misuse = ["#!/bin/bash", "# Usage: hello.sh before|after", '[ "${1:-}" = before ] || { sed -n \'2,2p\' "$0"; exit 64; }', ""].join("\n");
    assert.equal(house("scripts/hello.sh", misuse).comments, 0);
    const bre = ["#!/bin/sh", "# Usage: hello.sh", "(", "case \"$1\" in -h) sed -n '2,/^($/p' \"$0\" ;; esac", "# stray", ""].join("\n");
    assert.equal(house("scripts/hello.sh", bre).comments, 1);
    const aliased = ["#!/bin/bash", "# Usage: hello.sh <a>", "#", "#   more help", "set -u", 'here=$(cd "$(dirname "$0")" && pwd)', 'self=$here/$(basename "$0")', "help() { sed -n '2,/^set -u/p' \"$self\" | sed '$d'; }", "# stray", ""].join("\n");
    assert.equal(house("scripts/hello.sh", aliased).comments, 1);
    const wide = ["#!/bin/sh", "# Usage: hello.sh", "echo hi", "# stray", 'case "$1" in -h) sed -n \'2,$p\' "$0" ;; esac', ""].join("\n");
    assert.equal(house("scripts/hello.sh", wide).comments, 1);
    const bytes = ["#!/usr/bin/env node", "// Not help", 'import { readFileSync } from "node:fs";', 'if (process.argv.includes("--help")) console.log(readFileSync(new URL(import.meta.url), "utf8").length);', ""].join("\n");
    assert.equal(house("scripts/hello.mjs", bytes).comments, 1);
    const sliced = ["#!/usr/bin/env node", "// Usage: hello", "// not printed", 'import { readFileSync } from "node:fs";', 'if (process.argv.includes("--help")) console.log(readFileSync(new URL(import.meta.url), "utf8").split("\\n").slice(1, 2).map((l) => l.replace(/^\\/\\/ ?/, "")).join("\\n"));', ""].join("\n");
    assert.equal(house("scripts/hello.mjs", sliced).comments, 1);
    const commented = ["#!/usr/bin/env node", "// Not help", 'import { readFileSync } from "node:fs";', 'if (process.argv.includes("--help")) {', '  // console.log(readFileSync(import.meta.filename, "utf8"));', '  console.log("usage: hello");', "}", ""].join("\n");
    assert.equal(house("scripts/hello.mjs", commented).comments, 2);
    const pyCommented = ["#!/usr/bin/env python3", "# Not help", "import sys", "if '--help' in sys.argv:", "    # print(open(__file__).read())", "    print('usage: hello')", ""].join("\n");
    assert.equal(house("scripts/hello.py", pyCommented).comments, 2);
    const unread = ["#!/usr/bin/env node", "// Not help", 'import { readFileSync } from "node:fs";', "const self = readFileSync(new URL(import.meta.url), \"utf8\").length;", ""].join("\n");
    assert.equal(house("scripts/hello.mjs", unread).comments, 1);
    const alias = ["#!/usr/bin/env node", "// Usage: hello", 'const here = fileURLToPath(import.meta.url);', "const help = () => {", '  const lines = readFileSync(here, "utf8").split("\\n");', '  console.log(lines.filter((l) => l.startsWith("//")).join("\\n"));', "};", ""].join("\n");
    assert.equal(house("scripts/agent/hello", alias).comments, 0);
    const js = ["#!/usr/bin/env node", "// Usage: hello.mjs", "// Says hello.", 'import { readFileSync } from "node:fs";', "if (process.argv.includes(\"--help\")) console.log(readFileSync(new URL(import.meta.url), \"utf8\").split(\"\\n\").filter((l) => l.startsWith(\"//\")).join(\"\\n\"));", "// stray", ""].join("\n");
    assert.equal(house("scripts/hello.mjs", js).comments, 1);
    const ps = ["<#", ".SYNOPSIS", "Says hello.", "#>", "#Requires -Version 7", "Write-Host hi # stray", ""].join("\n");
    assert.equal(house("scripts/hello.ps1", ps).comments, 1);
  });
  test("Python comments and docstrings count, except the docstring printed as --help and type or lint directives", () => {
    const body = ['x = "# not"  # noqa: E501', "y = 1  # type: ignore", "def f():", '    """Doc."""', '    return f"{x}#"  # why', ""];
    assert.equal(house("scripts/hello.py", ["#!/usr/bin/env python3", '"""Usage: hello.py"""', ...body].join("\n")).comments, 3);
    assert.equal(house("scripts/hello.py", ["#!/usr/bin/env python3", '"""Usage: hello.py"""', "import sys", "print(__doc__)", ...body].join("\n")).comments, 2);
    assert.equal(house("scripts/hello.py", ['s = ("a"', '     "b")', 'call("""x""")', ""].join("\n")).comments, 0);
  });
  test("YAML comments count, and a run block is scanned as the shell it runs in", () => {
    const workflow = [
      "on: push",
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: |",
      "          # a step note",
      '          echo "#x" a#b',
      "          cat <<EOF",
      "          # heredoc text",
      "          EOF",
      '      - name: "a # b"',
      "        run: echo hi # trailing",
      "      - shell: pwsh",
      "        run: |",
      '          $a = "x`"#y"',
      "          Start-Sleep -Seconds 1",
      "      - uses: actions/github-script@0000000000000000000000000000000000000000",
      "        with:",
      "          script: |",
      "            // a script note",
      "            core.info('#ok')",
      "      - name: Notes",
      "        description: >",
      "          # plain text, not a comment",
      "",
    ].join("\n");
    assert.deepEqual(house(".github/workflows/hello.yml", workflow), { comments: 3, sleeps: 1, skips: 0 });
    assert.equal(house(".github/workflows/hello.yml", 'message: abc:"xyz # actual\nother: x\n').comments, 1);
    assert.equal(house(".github/workflows/hello.yml", "jobs:\n  a:\n    steps:\n      - run: sleep 1 # why\n").sleeps, 1);
    const defaults = ["defaults:", "  run:", "    shell: pwsh", "jobs:", "  a:", "    steps:", "      - run: |", '          $x = "a#b"', "          Start-Sleep -Seconds 1", ""].join("\n");
    assert.deepEqual(house(".github/workflows/hello.yml", defaults), { comments: 0, sleeps: 1, skips: 0 });
    const later = ["jobs:", "  a:", "    steps:", "      - run: Start-Sleep -Seconds 1", "      - run: \"sleep 1\"", "      - uses: actions/github-script@0000000000000000000000000000000000000000", "        with:", "          script: return 1; // why", "defaults:", "  run:", "    shell: pwsh", ""].join("\n");
    assert.deepEqual(house(".github/workflows/hello.yml", later), { comments: 1, sleeps: 1, skips: 0 });
    assert.equal(house("apps/hello/config.yml", "description: &help |\n  # payload text\nother: !tag >\n  # more payload\n").comments, 0);
    assert.deepEqual(house(".github/workflows/hello.yml", 'jobs:\n  a:\n    steps:\n      - name: x\n        env:\n          run: sleep 1\n        run: echo hi\nbody: &body "a # literal fragment"\n'), { comments: 0, sleeps: 0, skips: 0 });
    assert.equal(house(".github/workflows/hello.yml", "jobs:\n  a:\n    steps:\n      - name: x\n        run: sleep 1\n").sleeps, 1);
    assert.deepEqual(house("apps/hello/config.yml", "script: |\n  // a literal\nrun: sleep 1\n"), { comments: 0, sleeps: 0, skips: 0 });
    assert.equal(house(".github/workflows/hello.yml", "jobs:\n  a:\n    steps:\n      - with:\n          script: |\n            // not github-script\n").comments, 0);
    const folded = ["jobs:", "  a:", "    steps:", "      - run: >", "          echo hello", "          sleep 1", ""].join("\n");
    assert.equal(house(".github/workflows/hello.yml", folded).sleeps, 0);
    const windows = ["jobs:", "  a:", "    runs-on: windows-latest", "    steps:", "      - run: Start-Sleep -Seconds 1", ""].join("\n");
    assert.equal(house(".github/workflows/hello.yml", windows).sleeps, 1);
    assert.equal(house(".github/workflows/hello.yml", windows.replace("runs-on: windows-latest", "runs-on:\n      - windows-latest")).sleeps, 1);
    assert.equal(house(".github/workflows/hello.yml", windows.replace("runs-on: windows-latest", "runs-on:\n    - windows-latest")).sleeps, 1);
    assert.equal(house("tools/tasks.yml", "version: 1\nname: tool\nshell: bash\ntasks:\n  run: echo hi\n").sleeps, 0);
    const wide = ["jobs:", "    a:", "        defaults:", "            run:", "                shell: pwsh", "        steps:", "            - run: Start-Sleep 1", ""].join("\n");
    assert.equal(house(".github/workflows/hello.yml", wide).sleeps, 1);
    assert.deepEqual(house(".github/workflows/hello.yml", "jobs:\n# a note\n  a:\n    runs-on: windows-latest\n# another\n    steps:\n      - run: Start-Sleep 1\n"), { comments: 2, sleeps: 1, skips: 0 });
    const emoji = ["jobs:", "  a:", "    steps:", "      - uses: actions/github-script@0000000000000000000000000000000000000000", "        with:", "          script: \"core.info('😀'); // note\"", ""].join("\n");
    assert.equal(house(".github/workflows/hello.yml", emoji).comments, 1);
    assert.equal(house(".github/workflows/hello.yml", 'jobs:\n  a:\n    steps:\n      - run: "echo preparing\\nsleep 1"\n').sleeps, 1);
    const jobs = ["jobs:", "  a:", "    defaults:", "      run:", "        shell: pwsh", "    steps:", "      - run: Start-Sleep 1", "  b:", "    steps:", "      - run: Start-Sleep 1", ""].join("\n");
    assert.equal(house(".github/workflows/hello.yml", jobs).sleeps, 1);
  });
  test("TOML, GN, Ruby and Dockerfile comments count outside strings", () => {
    assert.equal(house("packages/hello/Cargo.toml", 'name = "a#b" # c\nlit = \'#d\'\n').comments, 1);
    assert.equal(house("engine/hello/BUILD.gn", 'deps = [ "//a:b#c" ]  # why\n').comments, 1);
    assert.equal(house("apps/hello/Podfile", 's.sub(/"\\$\\{X\\}\\/)a/) { "#{$1}b" } # why\n').comments, 1);
    assert.equal(house("apps/hello/tool.rb", "x = <<~TEXT\n  # sample output\nTEXT\ny = %q{#abcdef} # why\nz = %w[a#b c]\n").comments, 1);
    assert.equal(house("apps/hello/tool.rb", "x = <<~'usage'\n  # sample\nusage\nwarn %q{# Example}\n").comments, 0);
    assert.equal(house("apps/hello/tool.rb", "x = <<~text\n  # sample output\ntext\n").comments, 0);
    assert.equal(house("apps/hello/a.xml", "<a><![CDATA[ <!-- not a comment --> ]]></a><!-- real -->\n").comments, 1);
    assert.equal(house("apps/hello/a.xml", "<!-- <![CDATA[ -->\n<a/>\n<!-- real -->\n").comments, 2);
    assert.equal(house("infra/hello/Dockerfile", "# syntax=docker/dockerfile:1\nFROM node\n# a note\nRUN echo a#b\n").comments, 1);
  });
  test("Kotlin, Rust, CSS and markup comments count, raw strings and lifetimes don't hide them", () => {
    assert.equal(house("apps/hello/Main.kt", 'val s = """// not\n"""\n/* a /* nested */ b */\nval t = "x" // c\n').comments, 2);
    assert.equal(house("packages/hello/src/lib.rs", 'fn a<\'a>(s: &\'a str) { let r = r#"// not "quoted""#; let c = \'"\'; } // c\n/// doc\n#[allow(dead_code)]\n').comments, 2);
    assert.equal(house("packages/hello/src/lib.rs", 'let r = r###########"a"b\n"###########;\n// actual\n').comments, 1);
    assert.equal(house("scripts/hello.sh", "cat <<42\n# payload\n42\necho $(( 1 << 2 )) # c\n").comments, 1);
    assert.equal(house("scripts/hello.sh", 'echo "(("; cat <<EOF\n# payload\nEOF\n(( x = 1 << 3 )) # c\n').comments, 1);
    assert.deepEqual(house("scripts/hello.sh", "cat <<<EOF\n# real\nsleep 1\nEOF\n"), { comments: 1, sleeps: 1, skips: 0 });
    assert.equal(house("apps/hello/a.css", "a { background: url(http://x/y.png); } /* c */\n").comments, 1);
    assert.equal(house("apps/hello/index.html", "<!-- c --><script>// js\nconst a = 1;</script><style>/* css */</style><script type=\"application/json\">{\"a\": \"//\"}</script>\n").comments, 3);
    assert.equal(house("apps/hello/index.html", "<!-- an example: <script>// inside</script> -->\n<p>hi</p>\n").comments, 1);
    assert.equal(house("apps/hello/index.html", "<script data-type=\"application/json\">// js\n</script>\n").comments, 1);
    assert.equal(house("apps/hello/Page.astro", "---\n// front\nconst a = 1;\n---\n<div>{/* jsx */}</div>\n").comments, 2);
  });
  test("license headers, generated files, third-party copies and lockfiles are left alone", () => {
    assert.equal(house("scripts/hello.sh", "#!/bin/bash\n# Copyright 2026 Someone. Licensed MIT.\necho hi\n").comments, 0);
    assert.equal(house("apps/hello/data.ts", "/*! Icons from Lucide (ISC) */\nexport const a = 1;\n").comments, 0);
    assert.equal(house("apps/hello/manifest.js", "// Generated by build.py. Do not edit.\nexport const a = 1; // x\n").comments, 0);
    assert.deepEqual(scannedPaths(["third_party/a/LICENSE", "third_party/a/x.py", "pnpm-lock.yaml", "a/b/fixtures/c.sh", "scripts/x.py", "scripts/tool"]), ["scripts/x.py", "scripts/tool"]);
  });
  test("a sleep counts unless a loop bounds it by a count or a deadline", () => {
    const shell = (body) => house("scripts/hello.sh", `${body}\n`).sleeps;
    assert.equal(shell("for _ in $(seq 1 50); do [ -s f ] && break; sleep 0.1; done"), 0);
    assert.equal(shell("until [ -s f ]; do sleep 1; done"), 1);
    assert.equal(shell("deadline=$((SECONDS + 30))\nuntil [ -s f ] || (( SECONDS > deadline )); do sleep 1; done"), 0);
    assert.equal(shell("while [ $i -lt 10 ]; do sleep 1; i=$((i+1)); done"), 0);
    assert.equal(shell('i=0\nwhile [ "$i" -lt 5 ]; do sleep 1; done'), 1);
    assert.equal(shell("until [ \"$(date +%s)\" -ge \"$end\" ]; do sleep 1; done"), 0);
    assert.equal(shell("for ((;;)); do sleep 1; done"), 1);
    assert.equal(shell("for ((i = 0; i < 5; i++)); do sleep 1; done"), 0);
    assert.equal(shell("for ((i=0; i<5;)); do sleep 1; done"), 1);
    assert.equal(shell("while true; do echo timeout; sleep 1; done"), 1);
    assert.equal(shell('for target in alpha beta; do echo waiting for "$target"; done\nsleep 1'), 1);
    assert.equal(shell('for target in alpha beta; do echo What to do for "$target"; done\nsleep 1'), 1);
    assert.equal(shell('case "$mode" in retry) sleep 1;; esac'), 1);
    assert.equal(shell("if sleep 1; then echo ready; fi\necho sleep 1"), 1);
    assert.equal(shell('x=`sleep 1`\necho "`sleep 2`" \'`sleep 3`\''), 2);
    assert.equal(shell("while true; do\n  (( SECONDS > deadline )) && break\n  sleep 1\ndone"), 0);
    assert.equal(shell('sleep 10\necho "sleep 5" && x && sleep 2'), 2);
    assert.equal(house("scripts/agent/await", "#!/bin/bash\nwhile true; do sleep 1; done\n").sleeps, 0);
    assert.equal(house("infra/hello/run.sh", "while true; do work; sleep 3600; done\n").sleeps, 0);
    const py = (body) => house("scripts/hello.py", `import time\n${body}\n`).sleeps;
    assert.equal(py("for _ in range(5):\n    time.sleep(1)"), 0);
    assert.equal(py("while True:\n    time.sleep(1)"), 1);
    assert.equal(py("n = 0\nwhile n < 5:\n    time.sleep(1)"), 1);
    assert.equal(py("n = 0\nwhile n < 5:\n    time.sleep(1)\n    n += 1"), 0);
    assert.equal(py("end = time.monotonic() + 5\nwhile time.monotonic() < end:\n    time.sleep(0.1)"), 0);
    assert.equal(py("time.sleep(2)"), 1);
    const js = (body) => house("apps/browser/src/state/hello/hello.test.mjs", `${body}\n`).sleeps;
    const helpers = "const wait = (ms) => new Promise((r) => setTimeout(r, ms));\nconst settle = () => new Promise((r) => setTimeout(r, 0));\n";
    assert.equal(js(`${helpers}await wait(50);\nawait settle();\nawait wait(0);`), 1);
    assert.equal(js(`${helpers}for (let i = 0; i < 20 && !ready(); i++) await wait(10);`), 0);
    assert.equal(js(`${helpers}while (!ready()) await wait(10);`), 1);
    assert.equal(js(`${helpers}let i = 0;\nwhile (i < 5) await wait(10);`), 1);
    assert.equal(js(`${helpers}for (let i = 0; i < 5;) await wait(1);`), 1);
    assert.equal(js(`${helpers}while (true) {\n  if (Date.now() > end && ready()) break;\n  await wait(10);\n}`), 1);
    assert.equal(js(`${helpers}while (true) {\n  if (Date.now() > end || ready()) break;\n  await wait(10);\n}`), 0);
    assert.equal(js(`${helpers}let i = 0;\nwhile (i < 5) {\n  await wait(10);\n  i++;\n}`), 0);
    assert.equal(js(`${helpers}while (true) {\n  ready({ timeout: 500 });\n  await wait(1);\n}`), 1);
    assert.equal(js(`${helpers}do {\n  ready();\n} while (retries-- > 0)\nawait wait(1);`), 1);
    assert.equal(js(`${helpers}await wait( 0);\nawait new Promise((r) => setTimeout(r, 0));`), 0);
    assert.equal(js(`${helpers}while (true) {\n  for (let attempts = 0; attempts < 3; attempts++) {\n    if (attempts === 2) break;\n  }\n  await wait(20);\n}`), 1);
    assert.equal(js(`${helpers}do ready(); while (retries-- > 0)\nawait wait(1);`), 1);
    assert.equal(js(`${helpers}while (true) {\n  do { retry(); } while (retries-- > 0);\n  if (ready()) break;\n  await wait(1);\n}`), 1);
    assert.equal(js(`${helpers}do await wait(\n  1\n); while (retries-- > 0);`), 0);
    assert.equal(js(`${helpers}for (const name of names) {\n  test(name, async () => {\n    await wait(5);\n  });\n}`), 1);
    assert.equal(js(`${helpers}for (const name of names) it(name, async () => await wait(5));`), 1);
    assert.equal(js(`${helpers}test("a", async () => {\n  for (let i = 0; i < 5 && !ready(); i++) {\n    if (i) log(i);\n    await wait(5);\n  }\n});`), 0);
    assert.equal(house("scripts/hello.ps1", "for ($i = 0; $i -lt 10; $i++) { Start-Sleep -Seconds 1 }\nwhile ($true) { Start-Sleep 1 }\n").sleeps, 1);
    assert.equal(house("scripts/hello.ps1", "Write-Output Start-Sleep\nGet-Help Start-Sleep\n").sleeps, 0);
    assert.equal(py("while True:\n    for attempt in range(3):\n        if attempt == 2:\n            break\n    time.sleep(1)"), 1);
    assert.equal(shell('out="$(sleep 1; date)"'), 1);
    assert.equal(js(`${helpers}const end = Date.now() + 500;\nwhile (!ready()) {\n  if (Date.now() > end) throw new Error("late");\n  await wait(10);\n}`), 0);
    assert.equal(js('import { setTimeout as delay } from "node:timers/promises";\nawait delay(30);\nawait new Promise((r) => setTimeout(r, 20));'), 2);
    assert.equal(house("apps/browser/src/state/hello/hello.ts", "await sleep(50);\n").sleeps, 0);
  });
  test("an unconditional skip, todo, quarantine or .only needs an owner and an expiry", () => {
    const js = (body) => house("apps/browser/src/state/hello/hello.test.mjs", `${body}\n`).skips;
    assert.equal(js('test("a", { skip: true }, () => {});'), 1);
    assert.equal(js('test("a", { todo: "C5 open, #3569" }, () => {});'), 1);
    assert.equal(js('test("a", { todo: "@alice until 2099-12-31: C5 open, #3569" }, () => {});'), 0);
    assert.equal(js('test("a", { todo: "@alice until 2099-02-30: C5 open" }, () => {});'), 1);
    assert.equal(js('test("a", { todo: "@alice until 2099-01-31.5: C5 open" }, () => {});'), 1);
    assert.equal(js('test("a", { skip: !onMac && "needs a Mac" }, () => {});'), 0);
    assert.equal(js('test("a", { skip: `flaky ${version}` }, () => {});'), 1);
    assert.equal(js('test("a", { skip: "" }, () => {});'), 0);
    assert.equal(js('test("a", {"skip": true}, () => {});\ntest("b", { "only": true }, () => {});'), 2);
    assert.equal(js('test(\n  "a",\n  {\n    timeout: 5,\n    skip: true\n      }, () => {});'), 1);
    assert.equal(js('test("a", () => { const fixture = { todo: "@alice until 2000-01-01" }; check({ skip: true }); });'), 0);
    assert.equal(js('const text = "test(\'a\', { skip: true })";'), 0);
    assert.equal(js('import { skip, only, todo as later } from "node:test";\nskip("broken", fn);\nonly("focused", fn);\nlater("soon");'), 3);
    assert.equal(js('const reason = "known issue";\ntest("a", { skip: reason }, fn);\ntest("b", { skip: enabled }, fn);'), 1);
    assert.equal(js('import test, { only } from "node:test";\nonly("focused", fn);'), 1);
    assert.equal(js('import { test as check } from "node:test";\ncheck.only("focused", fn);\ncheck("a", { skip: true }, fn);'), 2);
    assert.equal(js('import * as nodeTest from "node:test";\nnodeTest.only("a", fn);\nnodeTest.test.skip("b", fn);'), 2);
    assert.equal(js('test["only"]("a", fn);\ndescribe[\'skip\']("b", fn);\nconst text = "test[\'only\'](";'), 2);
    assert.equal(js('const opts = { only: true };\ntest("a", opts, fn);\nconst data = { skip: true };\nuse(data);'), 1);
    assert.equal(js('const run = test.only;\nrun("x", fn);\nconst helper = test.skip;'), 1);
    assert.equal(js('const only = true;\ntest("x", { only }, fn);\nconst skip = "flaky";\ntest("y", { skip }, fn);\nconst todo = false;\ntest("z", { todo }, fn);'), 2);
    assert.equal(house("apps/browser/src/state/hello/hello.test.ts", 'const REASON: string = "flaky";\ntest("a", { skip: REASON }, fn);\n').skips, 1);
    assert.equal(js('test.only("a", () => {});\ndescribe("b", { only: true }, () => {});'), 2);
    assert.equal(js('test.skip("a", () => {});\nit.todo("b");'), 2);
    assert.equal(js('const listing = [ext("b", "Old", { skip: "manifestV2" })];'), 0);
    const py = (body) => house("engine/hello/tests/test_hello.py", `${body}\n`).skips;
    assert.equal(py('@unittest.skip("flaky")\ndef test_a(self): pass'), 1);
    assert.equal(py('@unittest.skip("@bob until 2099-01-01: flaky")\ndef test_a(self): pass'), 0);
    assert.equal(py("@unittest.skipIf(sys.platform != 'linux', 'linux only')\ndef test_a(self): pass"), 0);
    assert.equal(py("@pytest.mark.xfail(sys.platform == 'win32', reason='x')\ndef test_a(): pass"), 0);
    assert.equal(py("@pytest.mark.xfail(reason='x')\ndef test_a(): pass"), 1);
    assert.equal(py("@pytest.mark.xfail(True, reason='x')\ndef test_a(): pass"), 1);
    assert.equal(py("@pytest.mark.xfail(condition=True, reason='x')\ndef test_a(): pass"), 1);
    assert.equal(py("@pytest.mark.xfail(\"sys.platform == 'win32'\", reason='flaky')\ndef test_a(): pass"), 0);
    assert.equal(py("@pytest.mark.xfail(True, reason='@bob until 2099-01-01: flaky')\ndef test_a(): pass"), 0);
    assert.equal(house("packages/hello/Tests/HelloTests.swift", '@Test(.disabled("flaky")) func a() {}\n@Test(.disabled(if: onCI)) func b() {}\n').skips, 1);
    assert.equal(house("packages/hello/src/lib.rs", '#[test]\n#[ignore]\nfn a() {}\n#[ignore = "@carol until 2099-01-01: needs network"]\nfn b() {}\n').skips, 1);
    assert.equal(house("packages/hello/android/src/test/java/HelloTest.kt", '@Ignore("flaky")\n@Test fun a() {}\n').skips, 1);
    const known = (failing) => house("apps/browser/scripts/sim/known.json", JSON.stringify({ failing, holding: [] }, null, 1)).skips;
    assert.equal(known([{ issue: 1, rule: "pins", steps: [] }]), 1);
    assert.equal(known([{ issue: 1, rule: "pins", owner: "@dana", expires: "2099-01-01", steps: [] }]), 0);
    assert.equal(known([{ issue: 1, rule: "pins", owner: "dana", expires: "2099-01-01", steps: [] }]), 1);
    assert.equal(known([null, 3]), 2);
    assert.equal(known([{ issue: 1, owner: ["@dana"], expires: "2099-01-01" }]), 1);
    assert.equal(house("apps/browser/scripts/sim/known.json", "null").skips, 0);
    assert.equal(house("apps/browser/scripts/sim/known.json", '{"failing":{}}').skips, 1);
  });
  test("a skip past its date warns and passes; .only and a date that isn't one fail", () => {
    const markers = [];
    const files = [
      ["apps/browser/src/state/hello/hello.test.mjs", 'test("a", { todo: "@alice until 2026-01-31: open" }, () => {});\ntest("b", { skip: "@bob until 2099-01-31: open" }, () => {});\n'],
      ["apps/browser/scripts/sim/known.json", JSON.stringify({ failing: [{ issue: 7, owner: "@dana", expires: "2026-02-01" }] })],
    ];
    findViolations(files, markers);
    const late = (today) => lapsed(markers, today).map(({ path, line, text }) => `${path}:${line} ${text}`);
    assert.deepEqual(late("2026-02-01"), ["apps/browser/src/state/hello/hello.test.mjs:1 todo for @alice expired 2026-01-31: fix it, or move the date with the owner's OK"]);
    assert.equal(late("2026-02-02").length, 2);
    assert.equal(late("2026-01-31").length, 0);
    assert.deepEqual(breaches(markers), [], "a passed date never fails");
    assert.equal(annotation(lapsed(markers, "2026-02-01")[0]), "::warning file=apps/browser/src/state/hello/hello.test.mjs,line=1::todo for @alice expired 2026-01-31: fix it, or move the date with the owner's OK");
    assert.match(expirySummary([], lapsed(markers, "2026-02-01")), /^## Expiring skips\n\nPast their date \(a warning, not a failure\):\n\n- `apps\/browser\/src\/state\/hello\/hello\.test\.mjs:1` todo for @alice/);
    const impossible = [];
    findViolations([["apps/browser/src/state/hello/hello.test.mjs", 'test("a", { skip: "@a until 2099-02-30: x" }, () => {});\n'], ["apps/browser/scripts/sim/known.json", '{"failing":[{"issue":1,"owner":"@d","expires":"soon"}]}']], impossible);
    assert.equal(breaches(impossible).length, 2);
    const scoped = [];
    findViolations([["apps/browser/src/state/hello/hello.test.mjs", 'describe("a", () => {\n  const reason = "@al until 2099-01-01: x";\n  test("a", { skip: reason }, fn);\n});\ndescribe("b", () => {\n  const reason = "@al until 2001-01-01: x";\n  test("b", { skip: reason }, fn);\n});\n']], scoped);
    assert.deepEqual(lapsed(scoped, "2026-01-01").map(({ line, text }) => `${line} ${text.split(":")[0]}`), ["7 skip for @al expired 2001-01-01"]);
    const focused = [];
    findViolations([["apps/browser/src/state/hello/hello.test.mjs", 'test.only("a", () => {});\n']], focused);
    assert.deepEqual(breaches(focused), ["  apps/browser/src/state/hello/hello.test.mjs:1 .only, which never belongs in a commit"]);
    const owners = [];
    findViolations([["apps/browser/scripts/sim/known.json", JSON.stringify({ failing: [{ issue: 1, expires: "2099-01-01" }, { issue: 2, owner: "@dana", expires: "" }, { issue: 3, owner: "@dana" }] })]], owners);
    assert.deepEqual(breaches(owners), ['  apps/browser/scripts/sim/known.json:1 quarantine until "", which isn\'t a date (YYYY-MM-DD) with an @owner']);
    assert.equal(house("apps/browser/scripts/sim/known.json", JSON.stringify({ failing: [{ issue: 1, expires: "2099-01-01" }] })).skips, 1);
    const twice = [];
    findViolations([["apps/browser/scripts/sim/known.json", '{"failing":[{"issue":7,"owner":"@dana","expires":"2026-01-01"},\n{"issue":7,"owner":"@dana","expires":"2026-01-02"}]}']], twice);
    assert.deepEqual(twice.map((marker) => marker.line), [1, 2]);
  });
  const scan = (() => {
    let result = null;
    return () => {
      if (!result) {
        const markers = [];
        result = { found: findViolations(workingTreeFiles(), markers), markers };
      }
      return result;
    };
  })();
  test("no .only and no date that isn't one; a skip past its date only warns", (t) => {
    const { markers } = scan();
    for (const warning of lapsed(markers, todayUtc())) {
      t.diagnostic(`warning: ${warning.path}:${warning.line} ${warning.text}`);
      console.log(annotation(warning));
    }
    const failing = breaches(markers);
    assert.equal(failing.length, 0, `.only, or an expiry that isn't a date (docs/conventions.md, expiring-skip):\n${failing.join("\n")}`);
  });
  test("conventions hold, except what the baseline lists", (t) => {
    const baseline = JSON.parse(readFileSync(ROOT + BASELINE_PATH, "utf8"));
    const { found } = scan();
    t.diagnostic(scoreboard(found));
    const problems = compare(baseline, found);
    assert.equal(
      problems.length,
      0,
      `Conventions check (docs/conventions.md). New violations fail; fixed ones must leave the baseline (node apps/browser/src/conventions.test.mjs --write-baseline):\n${problems.join("\n")}`,
    );
  });
}
