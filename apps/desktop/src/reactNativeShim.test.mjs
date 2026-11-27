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

export function reactNativeMembers(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const locals = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !/^react-native(-macos)?$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (statement.importClause?.isTypeOnly || !bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      locals.set(element.name.text, (element.propertyName ?? element.name).text);
    }
  }
  const used = [];
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && locals.has(node.expression.text)) {
      used.push({ api: locals.get(node.expression.text), member: node.name.text, at: `${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}` });
    }
    ts.forEachChild(node, visit);
  };
  if (locals.size) visit(source);
  return used;
}

test("the scan reads value uses of a react-native import and skips type positions, type-only imports and other modules", () => {
  const text = [
    'import { AccessibilityInfo as A11y, Animated, type ViewStyle } from "react-native";',
    'import type { Image } from "react-native";',
    'import { Platform } from "./elsewhere";',
    "const node: Animated.AnimatedNode = null as never;",
    "A11y.isHighContrastEnabled();",
    "Animated.timing(node, {});",
    "Image.resolveAssetSource(1); Platform.OS;",
  ].join("\n");
  assert.deepEqual(reactNativeMembers("demo.ts", text).map(({ api, member }) => `${api}.${member}`), ["AccessibilityInfo.isHighContrastEnabled", "Animated.timing"]);
});

test("every react-native API member the shared UI uses at run time exists in the desktop react-native shim", async () => {
  const shim = await import("./shims/react-native.tsx");
  const used = sharedSources().flatMap((path) => reactNativeMembers(path, readFileSync(REPO + path, "utf8")));
  assert.ok(used.some(({ api, member }) => api === "AccessibilityInfo" && member === "isHighContrastEnabled"), "the scan still finds the sidebar's contrast check");
  const missing = [];
  for (const { api, member, at } of used) {
    if (LOOKUP_MAPS.has(api)) continue;
    const value = shim[api];
    if (value === undefined) missing.push(`${api} (${at})`);
    else if ((typeof value === "object" || typeof value === "function") && value !== null && !(member in value)) missing.push(`${api}.${member} (${at})`);
  }
  assert.deepEqual([...new Set(missing)], [], "add the member to apps/desktop/src/shims/react-native.tsx, or guard the call where react-native-web has no twin");
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
