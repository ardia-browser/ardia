import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SHARED_ROOTS = ["apps/browser/src/", "apps/desktop/src/", "packages/shell/src/", "packages/ardiacore/src/", "packages/core/src/", "packages/sync/src/", "packages/import/src/", "packages/shaders/src/"];
const NOT_ON_THE_DESKTOP = /(^|\/)test-native\/|\.test\.|\.mac\.tsx?$|\.ios\.tsx?$|\/platform\/mac\//;
const LOOKUP_MAPS = new Set(["NativeModules"]);

const sharedSources = () => SHARED_ROOTS.flatMap((root) =>
  readdirSync(REPO + root, { recursive: true })
    .map((file) => `${root}${String(file).replaceAll("\\", "/")}`)
    .filter((path) => /\.tsx?$/.test(path) && !path.endsWith(".d.ts") && !NOT_ON_THE_DESKTOP.test(path)));

const literalKey = (node) => ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ? node.text : null;

function accessOf(node) {
  if (ts.isPropertyAccessExpression(node)) return { target: node.expression, member: ts.isIdentifier(node.name) ? node.name.text : null, optional: !!node.questionDotToken };
  if (ts.isElementAccessExpression(node)) return { target: node.expression, member: literalKey(node.argumentExpression), optional: !!node.questionDotToken };
  return null;
}

const WRAPPERS = [ts.isParenthesizedExpression, ts.isNonNullExpression, ts.isAsExpression, ts.isSatisfiesExpression, ts.isTypeAssertionExpression];

function useOf(node) {
  let outer = node;
  while (outer.parent && WRAPPERS.some((is) => is(outer.parent)) && outer.parent.expression === outer) outer = outer.parent;
  const parent = outer.parent;
  if (parent && ts.isCallExpression(parent) && parent.expression === outer) return { kind: "call", optional: !!parent.questionDotToken };
  const access = parent && accessOf(parent);
  return { kind: "read", optional: !!access && access.target === outer && access.optional };
}

export function reactNativeMembers(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const locals = new Map();
  const namespaces = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !/^react-native(-macos)?$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (statement.importClause?.isTypeOnly || !bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      locals.set(element.name.text, (element.propertyName ?? element.name).text);
    }
  }
  const used = [];
  const destructured = new Map();
  const at = (node) => `${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const isNamespace = (node) => ts.isIdentifier(node) && namespaces.has(node.text);
  const apiOf = (expression) => {
    if (ts.isIdentifier(expression) && locals.has(expression.text)) return locals.get(expression.text);
    const access = accessOf(expression);
    return access && isNamespace(access.target) ? access.member : null;
  };
  const visit = (node) => {
    const access = accessOf(node);
    if (access?.member) {
      if (isNamespace(access.target)) used.push({ api: access.member, member: null, ...useOf(node), at: at(node) });
      else {
        const api = apiOf(access.target);
        if (api) used.push({ api, member: access.member, ...useOf(node), at: at(node) });
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
      const api = apiOf(node.initializer);
      if (api) {
        for (const element of node.name.elements) {
          if (element.dotDotDotToken) continue;
          const key = element.propertyName ?? element.name;
          const member = ts.isIdentifier(key) ? key.text : literalKey(key);
          if (!member) continue;
          const optional = !!element.initializer;
          used.push({ api, member, kind: "read", optional, at: at(element) });
          if (ts.isIdentifier(element.name)) destructured.set(element.name.text, { api, member, optional });
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && destructured.has(node.expression.text)) {
      const { api, member, optional } = destructured.get(node.expression.text);
      used.push({ api, member, kind: "call", optional: optional || !!node.questionDotToken, at: at(node) });
    }
    ts.forEachChild(node, visit);
  };
  if (locals.size || namespaces.size) visit(source);
  return used;
}

const absent = (value) => value === undefined || value === null;

export function missingFromShim(shim, used, lookupMaps = LOOKUP_MAPS) {
  const missing = [];
  for (const { api, member, kind, optional, at } of used) {
    if (lookupMaps.has(api)) continue;
    const exported = shim[api];
    const value = member === null ? exported : absent(exported) ? undefined : exported[member];
    const name = `${member === null ? api : `${api}.${member}`}${kind === "call" ? "()" : ""} (${at})`;
    if (member !== null && absent(exported)) {
      missing.push(`${api} (${at})`);
      continue;
    }
    if (kind === "call") {
      if (optional ? !absent(value) && typeof value !== "function" : typeof value !== "function") missing.push(name);
    } else if (!optional && value === undefined) {
      missing.push(name);
    }
  }
  return [...new Set(missing)];
}

test("the scan reads value uses of a react-native import and skips type positions, type-only imports, dynamic keys and other modules", () => {
  const text = [
    'import { AccessibilityInfo as A11y, Animated, type ViewStyle } from "react-native";',
    'import type { Image } from "react-native";',
    'import * as RN from "react-native";',
    'import { Platform } from "./elsewhere";',
    "const node: Animated.AnimatedNode = null as never;",
    "A11y.isHighContrastEnabled();",
    "Animated.timing(node, {});",
    "Image.resolveAssetSource(1); Platform.OS;",
    'A11y["announceForAccessibility"]("hi");',
    "const key = 'fetch'; A11y[key]();",
    "const { isScreenReaderEnabled, fetch: lookUp = () => null, ...rest } = A11y;",
    "isScreenReaderEnabled(); lookUp(); rest.anything();",
    "RN.Keyboard.dismiss(); RN.Linking.openURL?.(''); RN.Dimensions; RN.Vibration();",
    "A11y.setAccessibilityFocus?.(1); (A11y.isReduceMotionEnabled)(); (A11y.addEventListener as never)(); A11y.optional?.deep;",
  ].join("\n");
  const shape = ({ api, member, kind, optional }) => `${api}${member === null ? "" : `.${member}`}:${kind}${optional ? "?" : ""}`;
  assert.deepEqual(reactNativeMembers("demo.ts", text).map(shape), [
    "AccessibilityInfo.isHighContrastEnabled:call",
    "Animated.timing:call",
    "AccessibilityInfo.announceForAccessibility:call",
    "AccessibilityInfo.isScreenReaderEnabled:read",
    "AccessibilityInfo.fetch:read?",
    "AccessibilityInfo.isScreenReaderEnabled:call",
    "AccessibilityInfo.fetch:call?",
    "Keyboard.dismiss:call",
    "Keyboard:read",
    "Linking.openURL:call?",
    "Linking:read",
    "Dimensions:read",
    "Vibration:call",
    "AccessibilityInfo.setAccessibilityFocus:call?",
    "AccessibilityInfo.isReduceMotionEnabled:call",
    "AccessibilityInfo.addEventListener:call",
    "AccessibilityInfo.optional:read?",
  ]);
});

test("a member is missing when a call finds no function (an optional call only when the member is there), a read finds undefined, or the API isn't exported", () => {
  const shim = { A: { call: () => {}, value: 0, flag: false, truthy: true, nothing: undefined }, B: null, F: () => {}, O: {} };
  const use = (api, member, kind = "call", optional = false) => ({ api, member, kind, optional, at: "x.ts:1" });
  assert.deepEqual(missingFromShim(shim, [
    use("A", "call"), use("A", "call", "call", true), use("A", "value", "read"), use("A", "flag", "read"), use("A", "missing", "call", true),
    use("A", "nothing", "read", true), use("A", "nothing", "call", true), use("F", null), use("O", null, "read"), use("Q", null, "read", true),
  ], new Set()), []);
  assert.deepEqual(missingFromShim(shim, [
    use("A", "value"), use("A", "truthy"), use("A", "truthy", "call", true), use("A", "nothing", "read"), use("A", "gone"),
    use("B", "any"), use("C", null, "read"), use("O", null), use("A", "flag", "call", true),
  ], new Set()), ["A.value() (x.ts:1)", "A.truthy() (x.ts:1)", "A.nothing (x.ts:1)", "A.gone() (x.ts:1)", "B (x.ts:1)", "C (x.ts:1)", "O() (x.ts:1)", "A.flag() (x.ts:1)"]);
});

test("every react-native API member the shared UI uses at run time exists in the desktop react-native shim with a value of the kind it is used as", async () => {
  const shim = await import("./shims/react-native.tsx");
  const used = sharedSources().flatMap((path) => reactNativeMembers(path, readFileSync(REPO + path, "utf8")));
  assert.ok(used.some(({ api, member, kind }) => api === "AccessibilityInfo" && member === "isHighContrastEnabled" && kind === "call"), "the scan still finds the sidebar's contrast check");
  assert.deepEqual(missingFromShim(shim, used), [], "add the member to apps/desktop/src/shims/react-native.tsx, or guard the use with ?. where react-native-web has no twin");
});

test("high contrast follows the system's contrast media query and stops when the listener is removed", async () => {
  const { createAccessibilityInfo, HIGH_CONTRAST_QUERY } = await import("./shims/web/accessibilityInfo.ts");
  assert.match(HIGH_CONTRAST_QUERY, /prefers-contrast: more/);
  assert.match(HIGH_CONTRAST_QUERY, /forced-colors: active/);
  const listeners = new Set();
  const query = { matches: true, addEventListener: (_type, listener) => listeners.add(listener), removeEventListener: (_type, listener) => listeners.delete(listener) };
  const info = createAccessibilityInfo(() => query);
  assert.equal(await info.isHighContrastEnabled(), true);
  const seen = [];
  const subscription = info.addEventListener("highContrastChanged", (on) => seen.push(on));
  for (const listener of listeners) listener({ matches: false });
  subscription.remove();
  assert.equal(listeners.size, 0);
  assert.deepEqual(seen, [false]);
  const plain = createAccessibilityInfo(() => null);
  assert.equal(await plain.isHighContrastEnabled(), false);
  plain.addEventListener("highContrastChanged", () => assert.fail("no query, no events")).remove();
  assert.equal(typeof plain.addEventListener("screenReaderChanged", () => {}).remove, "function");
  assert.equal(typeof plain.isReduceMotionEnabled, "function");
});

test("an image source resolves to its URI the way react-native's Image.resolveAssetSource does", async () => {
  const { resolveAssetSource } = await import("./shims/web/ScaledImage.tsx");
  assert.deepEqual(resolveAssetSource("/assets/a.png"), { uri: "/assets/a.png" });
  assert.deepEqual(resolveAssetSource({ uri: "/assets/b.png", width: 2 }), { uri: "/assets/b.png" });
  assert.deepEqual(resolveAssetSource([{ uri: "/assets/c.png" }]), { uri: "/assets/c.png" });
  assert.equal(resolveAssetSource(7), null);
  assert.equal(resolveAssetSource(null), null);
});
