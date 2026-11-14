import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appBuild, appVersion, nativeApiVersion } from "./version.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: { main: "src/main.ts", preload: "src/preload.ts" },
  outdir: "out",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: "linked",
  logLevel: "warning",
  define: {
    __ARDIA_VERSION__: JSON.stringify(appVersion),
    __ARDIA_BUILD__: JSON.stringify(appBuild),
    __ARDIA_NATIVE_API_VERSION__: String(nativeApiVersion),
    __ARDIA_UPDATE_REPOSITORY__: JSON.stringify(process.env.ARDIA_UPDATE_REPOSITORY || process.env.GITHUB_REPOSITORY || "narasaka/ardia"),
    __ARDIA_DEBUG__: String(process.env.ARDIA_DEBUG_BUILD === "1"),
    "process.env.NODE_ENV": JSON.stringify(process.env.ARDIA_DEBUG_BUILD === "1" ? "development" : "production"),
  },
});

await import("./build-page-preload.mjs");

const iconSet = `${root}../macos/Ardia-macOS/Assets.xcassets/AppIcon.appiconset/`;
const iconSizes = { "16x16": "icon_16x16_1x", "32x32": "icon_32x32_1x", "64x64": "icon_32x32_2x", "128x128": "icon_128x128_1x", "256x256": "icon_256x256_1x", "512x512": "icon_512x512_1x", "1024x1024": "icon_512x512_2x" };
mkdirSync(`${root}out/icons`, { recursive: true });
for (const [size, source] of Object.entries(iconSizes)) copyFileSync(`${iconSet}${source}.png`, `${root}out/icons/${size}.png`);
copyFileSync(`${root}../windows/Ardia/IntroMusic.wav`, `${root}out/IntroMusic.wav`);
