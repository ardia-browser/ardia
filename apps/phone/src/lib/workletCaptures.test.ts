import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JS_ONLY_MODULES = /\b(Keyboard|Platform|AccessibilityInfo|Linking|BackHandler|Alert|Share|Vibration|Dimensions|Appearance)\./;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "dev" ? [] : files(path);
    return /\.tsx?$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

function balanced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(" || text[i] === "{") depth++;
    else if (text[i] === ")" || text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

function localImports(file: string, source: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(\.[^"]+)"/g)) {
    const base = resolve(dirname(file), match[2]!);
    const target = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(existsSync);
    if (!target) continue;
    for (const part of match[1]!.split(",")) {
      const name = part.replace(/^\s*type\s+/, "").split(" as ").pop()!.trim();
      if (name) map.set(name, target);
    }
  }
  return map;
}

const requireFromHere = createRequire(import.meta.url);
const APP = resolve(SRC, "..");
const compiledFiles = new Map<string, string>();

function compiled(file: string): string {
  const known = compiledFiles.get(file);
  if (known !== undefined) return known;
  const babel = requireFromHere("@babel/core") as { transformFileSync: (file: string, options: object) => { code: string } | null };
  const code =
    babel.transformFileSync(file, {
      cwd: APP,
      filename: file,
      envName: "production",
      caller: { name: "metro", bundler: "metro", platform: "android", isDev: false, isServer: false, engine: "hermes", supportsStaticESM: false },
    })?.code ?? "";
  compiledFiles.set(file, code);
  return code;
}

type CompiledWorklet = { name: string; params: string; captures: string[]; code: string };

function compiledWorklets(code: string): CompiledWorklet[] {
  return [...code.matchAll(/_init_data=\{code:"((?:[^"\\]|\\.)*)"/g)].map((match) => {
    const source = JSON.parse(`"${match[1]!}"`) as string;
    const head = /^\(?function (\w+)\(([^)]*)\)\{(?:const[{[]([^}\]]*)[}\]]=this\.__closure;)?/.exec(source);
    const captures = (head?.[3] ?? "").split(",").map((part) => part.split(":")[0]!.trim()).filter(Boolean);
    return { name: head?.[1] ?? "?", params: head?.[2] ?? "", captures, code: source };
  });
}

function definesWorklet(code: string, name: string): boolean | null {
  if (new RegExp(`\\b${name}\\.__workletHash=`).test(code)) return true;
  if (new RegExp(`var ${name}=(?:exports\\.${name}=)?function \\w+Factory\\(`).test(code)) return true;
  if (new RegExp(`(?:var ${name}=(?:exports\\.${name}=)?(?:function\\b|async\\b|\\(|[\\w$]+=>)|function ${name}\\()`).test(code)) return false;
  return null;
}

function exportIsWorklet(file: string, name: string, seen = new Set<string>()): boolean | null {
  if (seen.has(`${file}#${name}`)) return null;
  seen.add(`${file}#${name}`);
  const own = definesWorklet(compiled(file), name);
  if (own !== null) return own;
  const source = readFileSync(file, "utf8");
  const reexport = new RegExp(`export \\{[^}]*\\b${name}\\b[^}]*\\} from "(\\.[^"]+)"`).exec(source);
  const target = reexport ? [`${resolve(dirname(file), reexport[1]!)}.ts`, `${resolve(dirname(file), reexport[1]!)}.tsx`].find(existsSync) : null;
  if (target) return exportIsWorklet(target, name, seen);
  const imported = localImports(file, source).get(name);
  return imported ? exportIsWorklet(imported, name, seen) : null;
}

export function workletProblems(file: string): string[] {
  const code = compiled(file);
  const imports = localImports(file, readFileSync(file, "utf8"));
  const where = file.slice(SRC.length + 1);
  const problems: string[] = [];
  for (const worklet of compiledWorklets(code)) {
    for (const name of worklet.captures) {
      if (JS_ONLY_MODULES.test(`${name}.`)) problems.push(`${where}: ${worklet.name} reads ${name}, a JS-only module`);
      if (new RegExp(`(?<![\\w$.])${name}\\b`).test(worklet.params)) problems.push(`${where}: ${worklet.name} reads ${name} in a default parameter, before its closure is unpacked`);
      if (!new RegExp(`(?<![\\w$.])${name}\\(`).test(worklet.code)) continue;
      const local = definesWorklet(code, name);
      const verdict = local !== null ? local : imports.has(name) ? exportIsWorklet(imports.get(name)!, name) : null;
      if (verdict === false) problems.push(`${where}: ${worklet.name} calls ${name}, which isn't a worklet`);
    }
  }
  return problems;
}

test("every worklet, as compiled, calls only worklets in its own file and across files, reads its closure only after unpacking it, and never touches React Native's JS-only modules", () => {
  const problems = files(SRC).flatMap(workletProblems);
  assert.deepEqual([...new Set(problems)], []);
});

test("the check reads the worklets as this Worklets plugin compiles them: every one has a name, and their captures are found", () => {
  const worklets = files(SRC).flatMap((file) => compiledWorklets(compiled(file)));
  assert.ok(worklets.length > 100, `${worklets.length} worklets`);
  assert.deepEqual(worklets.filter((worklet) => worklet.name === "?").map((worklet) => worklet.code.slice(0, 80)), []);
  assert.ok(worklets.filter((worklet) => worklet.captures.length > 0).length > worklets.length / 2);
});

test("a worklet that runs during render reads only shared values already declared above it, since the first style is computed at once", () => {
  const RENDER_TIME = ["useAnimatedStyle(", "useDerivedValue(", "useAnimatedProps("];
  const problems: string[] = [];
  for (const file of files(SRC)) {
    const source = readFileSync(file, "utf8");
    for (const opener of RENDER_TIME) {
      let at = source.indexOf(opener);
      while (at >= 0) {
        const region = balanced(source, at + opener.length - 1);
        for (const read of region.matchAll(/(?<![.\w])(\w+)\.value\b/g)) {
          const name = read[1]!;
          const declared = new RegExp(`(?:const|let|var)\\s+(?:${name}\\b|\\{[^}]*\\b${name}\\b[^}]*\\})`, "g");
          let declaration: RegExpExecArray | null;
          let before = false;
          let after: number | null = null;
          while ((declaration = declared.exec(source))) {
            if (declaration.index < at) before = true;
            else if (after === null) after = declaration.index;
          }
          if (!before && after !== null) problems.push(`${file.slice(SRC.length + 1)}: ${opener}…${name}.value) comes before ${name} is declared`);
        }
        at = source.indexOf(opener, at + 1);
      }
    }
  }
  assert.deepEqual([...new Set(problems)], []);
});
