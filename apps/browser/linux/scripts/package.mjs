import { build as buildPackages, Platform } from "electron-builder";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appVersion } from "./version.mjs";

const HELP = `Usage: pnpm -C apps/browser/linux package [--arch x64|arm64|all] [--target AppImage|deb|dir|all]
Packages the built UI (ui/) and main process (out/) as an AppImage and a .deb in dist/. Run \`pnpm build\` first.`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};

const root = fileURLToPath(new URL("..", import.meta.url));
const stage = join(root, "dist", "app");
const arches = option("--arch", "x64") === "all" ? ["x64", "arm64"] : [option("--arch", "x64")];
const targetOption = option("--target", "all");
const targets = targetOption === "all" ? ["AppImage", "deb"] : [targetOption];

for (const required of ["out/main.js", "out/preload.js", "ui/index.html"])
  if (!existsSync(join(root, required))) {
    console.error(`package: ${required} is missing; run pnpm -C apps/browser/linux build first`);
    process.exit(1);
  }

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "out"), join(stage, "out"), { recursive: true, filter: (path) => !path.endsWith(".map") });
cpSync(join(root, "ui"), join(stage, "ui"), { recursive: true, filter: (path) => !path.endsWith(".map") });
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify({ name: "ardia", productName: "Ardia", desktopName: "ardia.desktop", version: appVersion, description: "Ardia, a web browser", main: "out/main.js", author: "Ardia <hello@ardia.dev>", homepage: "https://ardia.dev", license: "GPL-3.0" }, null, 2),
);

const CASTLABS_RELEASES = "https://github.com/castlabs/electron-releases/releases/download/";
const electronVersion = JSON.parse(readFileSync(join(root, "../../../node_modules/electron/package.json"), "utf8")).version;

const launcher = ["#!/usr/bin/env bash", readFileSync(join(root, "packaging/sandbox.sh"), "utf8"), readFileSync(join(root, "packaging/launcher.sh"), "utf8")].join("\n");

const config = {
  appId: "com.ardia.browser",
  productName: "Ardia",
  executableName: "ardia",
  copyright: "Ardia",
  directories: { app: stage, output: join(root, "dist"), buildResources: join(root, "packaging") },
  files: ["**/*"],
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  electronVersion,
  ...(electronVersion.includes("+wvcus") ? { electronDownload: { mirrorOptions: { mirror: CASTLABS_RELEASES } } } : {}),
  electronDist: arches.length === 1 && arches[0] === process.arch ? join(root, "../../../node_modules/electron/dist") : undefined,
  extraResources: [{ from: join(root, "packaging/apparmor-profile"), to: "apparmor-profile" }],
  artifactName: "Ardia-${version}-${arch}.${ext}",
  linux: {
    target: targets.map((target) => ({ target, arch: arches })),
    icon: join(root, "out/icons"),
    category: "Network;WebBrowser",
    syncDesktopName: true,
    synopsis: "A web browser",
    description: "Browse the web",
    maintainer: "Ardia <hello@ardia.dev>",
    vendor: "Ardia",
    executableName: "ardia",
    mimeTypes: ["text/html", "text/xml", "application/xhtml+xml", "x-scheme-handler/http", "x-scheme-handler/https"],
    desktop: {
      entry: {
        Name: "Ardia",
        GenericName: "Web Browser",
        Comment: "Browse the web",
        StartupWMClass: "ardia",
        StartupNotify: "true",
        Icon: "ardia",
        Actions: "new-window;",
      },
      desktopActions: { "new-window": { Name: "New Window", Exec: "ardia --new-window" } },
    },
  },
  deb: {
    packageName: "ardia",
    afterInstall: join(root, "packaging/after-install.sh"),
    depends: [
      "libgtk-3-0 | libgtk-3-0t64",
      "libnotify4",
      "libnss3",
      "libxss1",
      "libxtst6",
      "xdg-utils",
      "libatspi2.0-0 | libatspi2.0-0t64",
      "libuuid1",
      "libsecret-1-0",
      "libasound2 | libasound2t64",
      "libgbm1",
      "libcups2 | libcups2t64",
      "libdrm2",
      "libxkbcommon0",
      "libxcomposite1",
      "libxdamage1",
      "libxrandr2",
    ],
    recommends: ["libappindicator3-1"],
    priority: "optional",
  },
  appImage: { artifactName: "Ardia-${version}-${arch}.AppImage" },
  publish: null,
  afterPack: async (context) => {
    const folder = context.appOutDir;
    renameSync(join(folder, "ardia"), join(folder, "ardia.bin"));
    rmSync(join(folder, "resources", "default_app.asar"), { force: true });
    writeFileSync(join(folder, "ardia"), launcher);
    chmodSync(join(folder, "ardia"), 0o755);
  },
};

const built = await buildPackages({ projectDir: stage, targets: Platform.LINUX.createTarget(), config, publish: "never" });
for (const file of built) console.log(file);
