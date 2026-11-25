import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import type { Plugin, UserConfig } from "vite";
import { outDirFor, platformSuffixes, type DesktopMode } from "./desktopModes";
import { keyedPaths, pathKey, posixFilePath, toPosixPath } from "./desktopPaths";

const here = (path: string) => posixFilePath(new URL(path, import.meta.url));
const repo = here("../../");
const shims = here("./src/shims/");
const platformDir = here("./src/platform/");
const reactNativeWeb = toPosixPath(dirname(createRequire(import.meta.url).resolve("react-native-web/package.json")));

const realPackages: Record<string, string> = {
  shell: `${repo}packages/shell/src/index.tsx`,
  ardiacore: `${repo}packages/ardiacore/src/index.ts`,
  shaders: `${repo}packages/shaders/src/index.tsx`,
  sync: `${repo}packages/sync/src/index.ts`,
  import: `${repo}packages/import/src/index.ts`,
};

const ASSET = /\.(png|jpe?g|gif|webp|svg)$/;

function commonJsRequires(): Plugin {
  const scope = [`${repo}apps/browser/src/`, `${repo}packages/`].map(pathKey);
  return {
    name: "ardia-desktop:requires",
    enforce: "pre",
    transform(code, rawId) {
      const id = pathKey(rawId);
      if (!/\.(t|j)sx?$/.test(id) || !scope.some((dir) => id.startsWith(dir)) || !code.includes("require(")) return null;
      const specs: string[] = [];
      const body = code.replace(/\brequire\((["'])([^"']+)\1\)/g, (_match, _quote, spec: string) => {
        let index = specs.indexOf(spec);
        if (index < 0) index = specs.push(spec) - 1;
        return ASSET.test(spec) ? `__required${index}.default` : `__required${index}`;
      });
      if (!specs.length) return null;
      const imports = specs.map((spec, i) => `import * as __required${i} from ${JSON.stringify(spec)};`).join("\n");
      return { code: `${imports}\n${body}`, map: null };
    },
  };
}

const LAZY_COMPONENTS: Record<string, string[]> = {
  [`${repo}apps/browser/src/components/settings/UtilityWindow.tsx`]: ["UtilityWindow"],
  [`${repo}apps/browser/src/components/onboarding/OnboardingOverlay.tsx`]: ["OnboardingOverlay"],
  [`${repo}apps/browser/src/components/pages/InternalPage.tsx`]: ["InternalPage"],
  [`${repo}apps/browser/src/components/extensions/ExtensionOverlays.tsx`]: ["ExtensionOverlays", "InstallDialogHost"],
  [`${repo}apps/browser/src/components/extensions/SidePanel.tsx`]: ["ExtensionSidePanel"],
  [`${repo}apps/browser/src/components/bookmarks/BookmarkDialog.tsx`]: ["BookmarkDialog"],
  [`${repo}apps/browser/src/components/bookmarks/EditBookmarkDialog.tsx`]: ["EditBookmarkDialog"],
  [`${repo}apps/browser/src/components/littleArdia/LittleArdiaWindow.tsx`]: ["LittleArdiaWindow"],
};
const LAZY_COMPONENTS_BY_KEY = keyedPaths(Object.entries(LAZY_COMPONENTS));

const PLATFORM_PREFIX = "@platform/";

function platformSeams(mode: DesktopMode): Plugin {
  const candidates = (name: string) => platformSuffixes(mode).flatMap((suffix) => [`${platformDir}${name}${suffix}.ts`, `${platformDir}${name}${suffix}.tsx`]);
  return {
    name: "ardia-desktop:platform-seams",
    enforce: "pre",
    resolveId(source) {
      if (!source.startsWith(PLATFORM_PREFIX)) return null;
      const name = source.slice(PLATFORM_PREFIX.length);
      const found = candidates(name).find((file) => existsSync(file));
      if (!found) this.error(`${source} has no ${platformSuffixes(mode).map((suffix) => `${name}${suffix}.ts`).join(" or ")} in src/platform`);
      return found;
    },
  };
}

const LAZY_PREFIX = "\0ardia-lazy:";
const EAGER_QUERY = "?ardia-eager";
export const lazyComponentId = (file: string) => LAZY_PREFIX + file;

function lazyComponents(): Plugin {
  return {
    name: "ardia-desktop:lazy-components",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || source.endsWith(EAGER_QUERY) || importer.startsWith(LAZY_PREFIX)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const id = resolved && toPosixPath(resolved.id);
      if (!id || !LAZY_COMPONENTS_BY_KEY.has(pathKey(id))) return null;
      return LAZY_PREFIX + id;
    },
    load(id) {
      if (!id.startsWith(LAZY_PREFIX)) return null;
      const file = id.slice(LAZY_PREFIX.length);
      const names = LAZY_COMPONENTS_BY_KEY.get(pathKey(file))!;
      const lines = [
        `import { createElement, lazy, Suspense } from "react";`,
        `const load = () => import(${JSON.stringify(file + EAGER_QUERY)});`,
        ...names.flatMap((name) => [
          `const Lazy${name} = lazy(() => load().then((m) => ({ default: m.${name} })));`,
          `export function ${name}(props) { return createElement(Suspense, { fallback: null }, createElement(Lazy${name}, props)); }`,
        ]),
      ];
      return lines.join("\n");
    },
  };
}

const analyze = !!process.env.ARDIA_DESKTOP_ANALYZE;

export const resolveExtensions = (mode: DesktopMode): string[] => [
  ...platformSuffixes(mode).flatMap((suffix) => [`${suffix}.tsx`, `${suffix}.ts`]),
  ".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".mjs", ".js", ".jsx", ".json",
];

export function webShellConfig(mode: DesktopMode, options: { plugins?: Plugin[]; aliases?: { find: string | RegExp; replacement: string }[] } = {}): UserConfig {
  const outDir = outDirFor(mode);
  return {
    plugins: [
      platformSeams(mode),
      ...(options.plugins ?? []),
      commonJsRequires(),
      lazyComponents(),
      react(),
      analyze && visualizer({ filename: `${outDir}/stats.html`, gzipSize: true, template: "treemap" }),
      analyze && visualizer({ filename: `${outDir}/stats.json`, gzipSize: true, template: "raw-data" }),
    ],
    define: {
      __DEV__: "false",
      global: "globalThis",
    },
    resolve: {
      dedupe: ["react", "react-dom", "react-native-web"],
      extensions: resolveExtensions(mode),
      alias: [
        ...(options.aliases ?? []),
        { find: /^react-native\/Libraries\/Animated\/useAnimatedProps$/, replacement: `${reactNativeWeb}/dist/vendor/react-native/Animated/useAnimatedProps.js` },
        { find: /^react-native\/Libraries\/Core\/ExceptionsManager$/, replacement: `${shims}exceptions-manager.ts` },
        { find: /^react-native(-macos)?$/, replacement: `${shims}react-native.tsx` },
        { find: /^expo-modules-core$/, replacement: `${shims}expo-modules-core.ts` },
        { find: /^@ardia\/(shell|ardiacore|shaders|sync|import)$/, replacement: `${shims}$1.tsx` },
        ...Object.entries(realPackages).map(([name, path]) => ({ find: new RegExp(`^@ardia-real/${name}$`), replacement: path })),
      ],
    },
    optimizeDeps: {
      include: ["react-native-web", "lucide-react", "zustand", "zustand/react/shallow", "react-dom/client"],
    },
    build: {
      outDir,
      target: "es2022",
      sourcemap: false,
      chunkSizeWarningLimit: 4000,
    },
  };
}
