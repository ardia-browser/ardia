import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

globalThis.__DEV__ ??= false;

const fakes = new Map([
  ["expo-modules-core", new URL("./test-native/expo.ts", import.meta.url).href],
  ["react-native", new URL("./test-native/reactNative.ts", import.meta.url).href],
]);

const tsxCache = new URL("../node_modules/.cache/ardia-test-tsx/", import.meta.url);
let typescript;

function transpiledTsx(url) {
  const source = readFileSync(new URL(url), "utf8");
  const cached = new URL(`${createHash("sha1").update(url).update("\0").update(source).digest("hex")}.mjs`, tsxCache);
  if (existsSync(cached)) return readFileSync(cached, "utf8");
  typescript ??= createRequire(import.meta.url)("typescript");
  const { outputText } = typescript.transpileModule(source, {
    fileName: fileURLToPath(url),
    compilerOptions: {
      module: typescript.ModuleKind.ESNext,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  });
  mkdirSync(tsxCache, { recursive: true });
  const partial = new URL(`${cached.pathname.split("/").at(-1)}.${process.pid}`, tsxCache);
  writeFileSync(partial, outputText);
  renameSync(partial, cached);
  return outputText;
}

const LOCAL_REQUIRE = 'import { createRequire as __testCreateRequire } from "node:module"; const require = (id) => (/\\.(png|jpe?g|gif|svg|mp4|mp3|wav)$/.test(id) ? { testAsset: id } : __testCreateRequire(import.meta.url)(id));\n';

function withLocalRequire(source) {
  return /\brequire\(/.test(source) && !/\bconst require\b|\bcreateRequire\b/.test(source) ? LOCAL_REQUIRE + source : source;
}

const platform = process.env.ARDIA_TEST_PLATFORM;
const platformTwinsUnder = new URL("./lib/", import.meta.url).href;

function onPlatform(resolved, parentURL) {
  if (!platform || !resolved.url.startsWith(platformTwinsUnder) || !resolved.url.endsWith(".ts")) return resolved;
  const base = resolved.url.replace(/\.(windows|linux|web)\.ts$/, ".ts");
  if (parentURL?.startsWith(base.replace(/\.ts$/, "."))) return resolved;
  const twin = base.replace(/\.ts$/, `.${platform}.ts`);
  return existsSync(new URL(twin)) ? { ...resolved, url: twin } : resolved;
}

registerHooks({
  resolve(specifier, context, next) {
    if (fakes.has(specifier)) return { url: fakes.get(specifier), shortCircuit: true };
    try {
      return onPlatform(next(specifier, context), context.parentURL);
    } catch (error) {
      if (specifier.startsWith(".")) {
        for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
          try {
            return onPlatform(next(specifier + ext, context), context.parentURL);
          } catch {}
        }
      }
      throw error;
    }
  },
  load(url, context, next) {
    if (url.startsWith("file:") && url.endsWith(".tsx")) return { format: "module", source: withLocalRequire(transpiledTsx(url)), shortCircuit: true };
    if (url.startsWith("file:") && url.endsWith(".ts") && !url.includes("/node_modules/")) {
      const source = readFileSync(new URL(url), "utf8");
      if (/\brequire\(/.test(source) && !/\bcreateRequire\b/.test(source)) return { format: "module-typescript", source: withLocalRequire(source), shortCircuit: true };
    }
    return next(url, context);
  },
});
