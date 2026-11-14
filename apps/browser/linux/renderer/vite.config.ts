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

const SYSTEM_FONT_MODULE = /react-native-web\/dist\/(cjs\/)?exports\/StyleSheet\/compiler\/createReactDOMStyle\.js$/;
const linuxSystemFont = (code: string) => code.replace(`'${REACT_NATIVE_WEB_SYSTEM_STACK}'`, JSON.stringify(LINUX_UI_FONT_STACK));

function systemFontIsLinuxUiFont(): Plugin {
  return {
    name: "ardia-linux:system-font",
    transform(code, id) {
      return SYSTEM_FONT_MODULE.test(id) ? { code: linuxSystemFont(code), map: null } : null;
    },
  };
}

const prebundledSystemFont = {
  name: "ardia-linux:system-font",
  setup(build: { onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => Promise<{ contents: string; loader: "js" }>): void }) {
    build.onLoad({ filter: SYSTEM_FONT_MODULE }, async ({ path }) => ({ contents: linuxSystemFont(await readFile(path, "utf8")), loader: "js" }));
  },
};

const dev = process.env.ARDIA_LINUX_DEV === "1";

export default defineConfig({
  root: here("."),
  base: "./",
  plugins: [commonJsRequires(), systemFontIsLinuxUiFont(), react()],
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
  optimizeDeps: { include: ["react-native-web", "zustand", "zustand/react/shallow", "react-dom/client"], esbuildOptions: { plugins: [prebundledSystemFont] } },
  server: { host: "127.0.0.1", port: Number(process.env.ARDIA_VITE_PORT ?? 5281), strictPort: false, fs: { allow: [repo] } },
  build: { outDir: process.env.ARDIA_UI_OUT || here("../ui"), emptyOutDir: true, target: "chrome140", sourcemap: true, chunkSizeWarningLimit: 20000, minify: !dev },
});
