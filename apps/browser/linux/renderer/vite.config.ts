import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

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

const dev = process.env.ARDIA_LINUX_DEV === "1";

export default defineConfig({
  root: here("."),
  base: "./",
  plugins: [commonJsRequires(), react()],
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
  optimizeDeps: { include: ["react-native-web", "zustand", "zustand/react/shallow", "react-dom/client"] },
  server: { host: "127.0.0.1", port: Number(process.env.ARDIA_VITE_PORT ?? 5281), strictPort: false, fs: { allow: [repo] } },
  build: { outDir: process.env.ARDIA_UI_OUT || here("../ui"), emptyOutDir: true, target: "chrome140", sourcemap: true, chunkSizeWarningLimit: 20000, minify: !dev },
});
