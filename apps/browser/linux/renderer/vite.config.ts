import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { LINUX_UI_FONT_STACK, REACT_NATIVE_WEB_SYSTEM_STACK } from "../../../../packages/expo-linux/src/host/uiFont";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const repo = here("../../../../");
const expoLinux = `${repo}packages/expo-linux/src/`;
const reactNativeWeb = dirname(createRequire(import.meta.url).resolve("react-native-web/package.json"));

const ASSET = /\.(png|jpe?g|gif|webp|svg|mp3|m4a|wav)$/;

function commonJsRequires(): Plugin {
  const scope = [`${repo}apps/browser/`, `${repo}packages/`];
  return {
    name: "ardia-linux:requires",
    enforce: "pre",
    transform(code, id) {
      if (!/\.(t|j)sx?$/.test(id) || id.includes("/node_modules/") || !scope.some((dir) => id.startsWith(dir)) || !code.includes("require(")) return null;
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

type SourcePatch = { module: RegExp; from: string; to: string };

const reactNativeWebModule = (path: string) => new RegExp(`react-native-web/dist/(cjs/)?${path.replace(/[./]/g, (c) => `\\${c}`)}$`);

const REACT_NATIVE_WEB_PATCHES: SourcePatch[] = [
  {
    module: reactNativeWebModule("exports/StyleSheet/compiler/createReactDOMStyle.js"),
    from: `'${REACT_NATIVE_WEB_SYSTEM_STACK}'`,
    to: JSON.stringify(LINUX_UI_FONT_STACK),
  },
  {
    module: reactNativeWebModule("exports/UIManager/index.js"),
    from: "var height = node.offsetHeight;\n  var width = node.offsetWidth;",
    to: "var box = node.getBoundingClientRect();\n  var height = Math.abs(box.height - node.offsetHeight) < 1 ? box.height : node.offsetHeight;\n  var width = Math.abs(box.width - node.offsetWidth) < 1 ? box.width : node.offsetWidth;",
  },
];

function patchReactNativeWeb(code: string, id: string): string | null {
  const patch = REACT_NATIVE_WEB_PATCHES.find((each) => each.module.test(id));
  if (!patch) return null;
  if (!code.includes(patch.from)) throw new Error(`ardia-linux: react-native-web changed; ${id} no longer contains the source this build patches`);
  return code.replace(patch.from, patch.to);
}

function reactNativeWebPatches(): Plugin {
  return {
    name: "ardia-linux:react-native-web-patches",
    transform(code, id) {
      const patched = patchReactNativeWeb(code, id);
      return patched === null ? null : { code: patched, map: null };
    },
  };
}

const prebundledReactNativeWebPatches = {
  name: "ardia-linux:react-native-web-patches",
  setup(build: { onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => Promise<{ contents: string; loader: "js" } | undefined>): void }) {
    build.onLoad({ filter: /react-native-web\/dist\/.*\.js$/ }, async ({ path }) => {
      const patched = patchReactNativeWeb(await readFile(path, "utf8"), path);
      return patched === null ? undefined : { contents: patched, loader: "js" };
    });
  },
};

const dev = process.env.ARDIA_LINUX_DEV === "1";

export default defineConfig({
  root: here("."),
  base: "./",
  plugins: [commonJsRequires(), reactNativeWebPatches(), react()],
  define: {
    __DEV__: JSON.stringify(dev),
    global: "globalThis",
    "process.env.EXPO_OS": JSON.stringify("web"),
  },
  resolve: {
    dedupe: ["react", "react-dom", "react-native-web", "zustand"],
    extensions: [".linux.tsx", ".linux.ts", ".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".mjs", ".js", ".jsx", ".json"],
    alias: [
      { find: /^react-native\/Libraries\/Animated\/useAnimatedProps$/, replacement: `${reactNativeWeb}/dist/vendor/react-native/Animated/useAnimatedProps.js` },
      { find: /^react-native\/Libraries\/Core\/ExceptionsManager$/, replacement: `${expoLinux}reactNative/exceptionsManager.ts` },
      { find: /^react-native(-macos)?$/, replacement: `${expoLinux}reactNative/index.tsx` },
      { find: /^expo-modules-core$/, replacement: `${expoLinux}index.ts` },
      { find: /^expo$/, replacement: `${expoLinux}expo.ts` },
    ],
  },
  optimizeDeps: { include: ["react-native-web", "zustand", "zustand/react/shallow", "react-dom/client"], esbuildOptions: { plugins: [prebundledReactNativeWebPatches] } },
  server: { host: "127.0.0.1", port: Number(process.env.ARDIA_VITE_PORT ?? 5281), strictPort: false, fs: { allow: [repo] } },
  build: { outDir: process.env.ARDIA_UI_OUT || here("../ui"), emptyOutDir: true, target: "chrome140", sourcemap: true, chunkSizeWarningLimit: 20000, minify: !dev },
});
