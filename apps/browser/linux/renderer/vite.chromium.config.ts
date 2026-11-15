import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type UserConfig } from "vite";
import electronConfig from "./vite.config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const repo = here("../../../../");
const expoWindows = `${repo}packages/expo-windows/src/`;
const chromium = `${repo}packages/expo-linux/src/chromium/`;
const reactNativeOnLinux = `${repo}packages/expo-linux/src/reactNative/index.tsx`;

export const ENGINE_SWAPS: Record<string, string> = {
  [`${expoWindows}engine/host.ts`]: `${chromium}host.ts`,
  [`${expoWindows}modules.ts`]: `${chromium}modules.ts`,
  [`${expoWindows}animation/motion.ts`]: `${chromium}motion.ts`,
  [`${expoWindows}events.ts`]: `${chromium}events.ts`,
  [`${expoWindows}missing.ts`]: `${chromium}missing.ts`,
  [`${expoWindows}engine/windowId.ts`]: `${chromium}windowId.ts`,
};

const REPLACEMENTS = new Set(Object.values(ENGINE_SWAPS));

function engineSwaps(): Plugin {
  return {
    name: "ardia-linux:engine-swaps",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || REPLACEMENTS.has(importer)) return null;
      const fromWindows = importer.startsWith(expoWindows);
      if (fromWindows && (source === "react-native" || source === reactNativeOnLinux)) return `${chromium}reactNative.ts`;
      if (!source.startsWith(".") && !source.startsWith("/")) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const swapped = resolved && ENGINE_SWAPS[resolved.id];
      return swapped ?? null;
    },
  };
}

function engineEntry(): Plugin {
  return {
    name: "ardia-linux:engine-entry",
    transformIndexHtml: (html) => html.replace('src="./src/host.tsx"', 'src="./src/host.chromium.tsx"'),
  };
}

const base = electronConfig as UserConfig;
const extensions = base.resolve?.extensions ?? [];

export default defineConfig({
  ...base,
  plugins: [engineSwaps(), engineEntry(), ...(base.plugins ?? [])],
  resolve: { ...base.resolve, extensions: [".chromium.tsx", ".chromium.ts", ...extensions] },
  server: { ...base.server, port: Number(process.env.ARDIA_VITE_PORT ?? 5282) },
  build: { ...base.build, outDir: process.env.ARDIA_UI_OUT || here("../ui-chromium") },
});
