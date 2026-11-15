import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type UserConfig } from "vite";
import { inlineScripts, meadowDocument } from "../../../../packages/expo-linux/src/views/meadowDocument";
import { appBuild, appVersion, nativeApiVersion } from "../scripts/version.mjs";
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
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replace('src="./src/host.tsx"', 'src="./src/host.chromium.tsx"'),
    },
  };
}

const MEADOW_PAGE = `${repo}packages/shaders/ios/Meadow/index.html`;
const PAGE_SCRIPT = `${repo}packages/ardiacore/ios/page_script.js`;

export function inlineScriptHashes(): string[] {
  const scripts = inlineScripts(meadowDocument(readFileSync(MEADOW_PAGE, "utf8")));
  return [...new Set(scripts.map((script) => `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`))];
}

function contentSecurityHashes(): Plugin {
  let outDir = "";
  return {
    name: "ardia-linux:content-security-hashes",
    apply: "build",
    configResolved: (config) => void (outDir = config.build.outDir),
    writeBundle: () => {
      writeFileSync(join(outDir, "csp.json"), `${JSON.stringify({ scriptSrc: inlineScriptHashes() }, null, 2)}\n`);
      copyFileSync(PAGE_SCRIPT, join(outDir, "page_script.js"));
    },
  };
}

const base = electronConfig as UserConfig;
const extensions = base.resolve?.extensions ?? [];

export default defineConfig({
  ...base,
  plugins: [engineSwaps(), engineEntry(), contentSecurityHashes(), ...(base.plugins ?? [])],
  define: {
    ...base.define,
    __ARDIA_VERSION__: JSON.stringify(appVersion),
    __ARDIA_BUILD__: JSON.stringify(appBuild),
    __ARDIA_NATIVE_API_VERSION__: String(nativeApiVersion),
    __ARDIA_UPDATE_REPOSITORY__: JSON.stringify(process.env.ARDIA_UPDATE_REPOSITORY || process.env.GITHUB_REPOSITORY || "narasaka/ardia"),
    __ARDIA_DEBUG__: String(process.env.ARDIA_DEBUG_BUILD === "1"),
  },
  resolve: { ...base.resolve, extensions: [".chromium.tsx", ".chromium.ts", ...extensions] },
  server: { ...base.server, port: Number(process.env.ARDIA_VITE_PORT ?? 5282) },
  build: { ...base.build, outDir: process.env.ARDIA_UI_OUT || here("../ui-chromium") },
});
