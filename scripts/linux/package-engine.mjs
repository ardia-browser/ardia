#!/usr/bin/env node
const HELP = `Usage: node scripts/linux/package-engine.mjs [--engine <tar.xz>] [--ui <dir>] [--ublock <dir> | --no-ublock]
         [--arch x64|arm64] [--target deb|AppImage|dir|all] [--out <dir>]
Packages Ardia on its own engine: the engine tarball scripts/linux/engine/06-package.sh makes (default
~/ardia-linux/out/ardia-chromium-linux-<arch>.tar.xz) and the UI bundle (default apps/browser/linux/ui, from
pnpm -C apps/browser/linux build) as /opt/Ardia: chrome as ardia.bin, chrome_sandbox as chrome-sandbox,
ui/ without source maps, Extensions/ as the Mac bundles it (ublock: the pinned uBlock Origin scripts/linux/ubo.sh fetches,
or --ublock's; ublock.fingerprint; ublock-lite-settings), ardia.build.json (version and
build from apps/browser/linux/scripts/version.mjs), resources/apparmor-profile, and the ardia launcher (packaging/sandbox.sh,
CHROME_DESKTOP=ardia.desktop, packaging/launcher.sh). Then a .deb (dpkg-deb, chrome-sandbox setuid root, the AppArmor
profile installed by its postinst) and an AppImage (AppImage's static type2 runtime 20251108 and mksquashfs 4.6.1, from a
pinned, checksummed toolset cached in ~/.cache/ardia; zstd; no setuid helper, so it is sandboxed where user namespaces
work) in <out> (default apps/browser/linux/dist).
Refuses an engine that carries the test-build marker (ardia.test-build).`;

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};

const repo = fileURLToPath(new URL("../../", import.meta.url));
const linuxApp = join(repo, "apps/browser/linux");
const { appVersion, appBuild } = await import(join(linuxApp, "scripts/version.mjs"));
const arch = option("--arch", "x64");
const debArch = { x64: "amd64", arm64: "arm64" }[arch];
if (!debArch) fail(`--arch must be x64 or arm64, not ${arch}`);
const engine = option("--engine", join(homedir(), "ardia-linux/out", `ardia-chromium-linux-${arch}.tar.xz`));
const ui = option("--ui", join(linuxApp, "ui"));
const withUblock = !args.includes("--no-ublock");
const ublock = withUblock ? option("--ublock", join(repo, "packages/ardiacore/vendor/ubo/ext")) : "";
const out = option("--out", join(linuxApp, "dist"));
const targetOption = option("--target", "all");
const targets = targetOption === "all" ? ["deb", "AppImage"] : [targetOption];
for (const target of targets) if (!["deb", "AppImage", "dir"].includes(target)) fail(`unknown --target ${target}`);

function ublockFingerprint(folder) {
  const listing = execFileSync("bash", ["-c", "find . -type f ! -path './_metadata/*' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum"], { cwd: folder });
  return createHash("sha256").update(listing).digest("hex");
}

const APPIMAGE_TOOLS = {
  url: "https://github.com/electron-userland/electron-builder-binaries/releases/download/appimage@1.0.3/appimage-tools-runtime-20251108.tar.gz",
  sha256: "84021a78ee214ae6fd33a2d62a92ba25542dd10bc86bf117a9b2d0bba44e7665",
  folder: "appimage-tools-runtime-20251108",
};

function appImageTools(targetArch) {
  const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ardia");
  const folder = join(cache, APPIMAGE_TOOLS.folder);
  const tools = { runtime: join(folder, "runtimes", `runtime-${targetArch}`), mksquashfs: join(folder, "mksquashfs") };
  if (existsSync(tools.runtime) && existsSync(tools.mksquashfs)) return tools;
  mkdirSync(cache, { recursive: true });
  const download = mkdtempSync(join(cache, "appimage-tools-"));
  const archive = join(download, "tools.tar.gz");
  execFileSync("curl", ["-fsSL", "--retry", "3", "-o", archive, APPIMAGE_TOOLS.url], { stdio: ["ignore", "ignore", "inherit"] });
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (sha256 !== APPIMAGE_TOOLS.sha256) fail(`the AppImage toolset's checksum is ${sha256}, not ${APPIMAGE_TOOLS.sha256}`);
  const unpacked = join(download, "tools");
  mkdirSync(unpacked);
  execFileSync("tar", ["-xzf", archive, "-C", unpacked]);
  rmSync(folder, { recursive: true, force: true });
  renameSync(unpacked, folder);
  rmSync(download, { recursive: true, force: true });
  if (!existsSync(tools.runtime)) fail(`the AppImage toolset has no runtime for ${targetArch}`);
  return tools;
}

function fail(message) {
  console.error(`package-engine: ${message}`);
  process.exit(1);
}

if (!existsSync(engine)) fail(`no engine at ${engine}: run scripts/linux/engine/06-package.sh --apply (or pass --engine)`);
if (!existsSync(join(ui, "index.html"))) fail(`no UI bundle at ${ui}: run pnpm -C apps/browser/linux build (or pass --ui)`);
if (withUblock && !args.includes("--ublock")) execFileSync(join(repo, "scripts/linux/ubo.sh"), { stdio: ["ignore", "ignore", "inherit"] });
if (ublock && !existsSync(join(ublock, "manifest.json"))) fail(`${ublock} has no manifest.json`);

const packaging = join(linuxApp, "packaging");
const iconSet = join(repo, "apps/browser/macos/Ardia-macOS/Assets.xcassets/AppIcon.appiconset");
const iconSizes = { 16: "icon_16x16_1x", 32: "icon_32x32_1x", 64: "icon_32x32_2x", 128: "icon_128x128_1x", 256: "icon_256x256_1x", 512: "icon_512x512_1x" };
const desktopEntry = `[Desktop Entry]
Name=Ardia
GenericName=Web Browser
Comment=Browse the web
Exec=/opt/Ardia/ardia %U
Terminal=false
Type=Application
Icon=ardia
StartupWMClass=ardia
StartupNotify=true
Categories=Network;WebBrowser;
MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;
Actions=new-window;

[Desktop Action new-window]
Name=New Window
Exec=/opt/Ardia/ardia --new-window
`;
const debDepends = [
  "libasound2 | libasound2t64", "libatk-bridge2.0-0 | libatk-bridge2.0-0t64", "libatk1.0-0 | libatk1.0-0t64",
  "libatspi2.0-0 | libatspi2.0-0t64", "libc6 (>= 2.31)", "libcairo2", "libcups2 | libcups2t64", "libdbus-1-3", "libdrm2",
  "libexpat1", "libgbm1", "libglib2.0-0 | libglib2.0-0t64", "libgtk-3-0 | libgtk-3-0t64", "libnspr4", "libnss3 (>= 2:3.35)",
  "libpango-1.0-0", "libsecret-1-0", "libudev1", "libx11-6", "libxcb1", "libxcomposite1", "libxdamage1", "libxext6",
  "libxfixes3", "libxkbcommon0", "libxrandr2", "xdg-utils",
];

const work = mkdtempSync(join(tmpdir(), "ardia-package-engine-"));
const unpacked = join(work, "engine");
mkdirSync(unpacked);
execFileSync("tar", ["-xJf", engine, "-C", unpacked], { stdio: "inherit" });
const [top] = readdirSync(unpacked);
const engineDir = join(unpacked, top);
if (existsSync(join(engineDir, "ardia.test-build"))) fail(`${engine} is a test build (ardia.test-build): it can't be packaged`);
for (const required of ["chrome", "resources.pak", "icudtl.dat"]) if (!existsSync(join(engineDir, required))) fail(`${engine} has no ${required}`);

const root = join(work, "root");
const app = join(root, "opt/Ardia");
mkdirSync(join(root, "opt"), { recursive: true });
renameSync(engineDir, app);
for (const leftover of ["RUN.txt", "chrome-wrapper"]) rmSync(join(app, leftover), { force: true });
renameSync(join(app, "chrome"), join(app, "ardia.bin"));
const hasSandbox = existsSync(join(app, "chrome_sandbox"));
if (hasSandbox) renameSync(join(app, "chrome_sandbox"), join(app, "chrome-sandbox"));
cpSync(ui, join(app, "ui"), { recursive: true, filter: (path) => !path.endsWith(".map") });
if (ublock) {
  const extensions = join(app, "Extensions");
  cpSync(ublock, join(extensions, "ublock"), { recursive: true });
  writeFileSync(join(extensions, "ublock.fingerprint"), `${ublockFingerprint(join(extensions, "ublock"))}\n`);
  cpSync(join(repo, "packages/ardiacore/extensions/ublock-lite-settings"), join(extensions, "ublock-lite-settings"), { recursive: true });
}
writeFileSync(join(app, "ardia.build.json"), `${JSON.stringify({ version: appVersion, build: String(appBuild) })}\n`);
mkdirSync(join(app, "resources"), { recursive: true });
copyFileSync(join(packaging, "apparmor-profile"), join(app, "resources/apparmor-profile"));
const launcher = [
  "#!/usr/bin/env bash",
  readFileSync(join(packaging, "sandbox.sh"), "utf8").trimEnd(),
  "export CHROME_DESKTOP=ardia.desktop",
  readFileSync(join(packaging, "launcher.sh"), "utf8"),
].join("\n");
writeFileSync(join(app, "ardia"), launcher);
chmodSync(join(app, "ardia"), 0o755);

mkdirSync(join(root, "usr/share/applications"), { recursive: true });
writeFileSync(join(root, "usr/share/applications/ardia.desktop"), desktopEntry);
for (const [size, name] of Object.entries(iconSizes)) {
  const folder = join(root, `usr/share/icons/hicolor/${size}x${size}/apps`);
  mkdirSync(folder, { recursive: true });
  copyFileSync(join(iconSet, `${name}.png`), join(folder, "ardia.png"));
}

execFileSync("chmod", ["-R", "go-w", root]);
mkdirSync(out, { recursive: true });
const built = [];
const name = `Ardia-${appVersion}-engine`;

if (targets.includes("dir")) {
  const dir = join(out, `${name}-linux-${arch}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(app, dir, { recursive: true, verbatimSymlinks: true });
  built.push(dir);
}

if (targets.includes("deb")) {
  const deb = join(work, "deb");
  cpSync(root, deb, { recursive: true, verbatimSymlinks: true });
  if (hasSandbox) chmodSync(join(deb, "opt/Ardia/chrome-sandbox"), 0o4755);
  mkdirSync(join(deb, "DEBIAN"));
  const installedSize = execFileSync("du", ["-sk", "--apparent-size", "-c", join(deb, "opt"), join(deb, "usr")], { encoding: "utf8" }).trim().split("\n").at(-1).split("\t")[0];
  writeFileSync(join(deb, "DEBIAN/control"), `Package: ardia
Version: ${appVersion}
Architecture: ${debArch}
Maintainer: Ardia <hello@ardia.dev>
Installed-Size: ${installedSize}
Depends: ${debDepends.join(", ")}
Recommends: libvulkan1
Section: web
Priority: optional
Homepage: https://ardia.dev
Description: A web browser
 Ardia on its own engine: Chromium with Helium's patches and Ardia's.
`);
  copyFileSync(join(packaging, "after-install.sh"), join(deb, "DEBIAN/postinst"));
  writeFileSync(join(deb, "DEBIAN/prerm"), `#!/bin/bash
set -e
if [ "$1" = remove ] || [ "$1" = deconfigure ]; then
  if type update-alternatives >/dev/null 2>&1; then update-alternatives --remove ardia /opt/Ardia/ardia || true; fi
  if [ -L /usr/bin/ardia ] && [ "$(readlink /usr/bin/ardia)" = /opt/Ardia/ardia ]; then rm -f /usr/bin/ardia; fi
fi
exit 0
`);
  writeFileSync(join(deb, "DEBIAN/postrm"), `#!/bin/bash
set -e
if [ "$1" = remove ] || [ "$1" = purge ]; then
  rm -f /etc/apparmor.d/ardia
fi
exit 0
`);
  for (const script of ["postinst", "prerm", "postrm"]) chmodSync(join(deb, "DEBIAN", script), 0o755);
  const file = join(out, `${name}-${debArch}.deb`);
  execFileSync("dpkg-deb", ["--root-owner-group", "-Zxz", "--build", deb, file], { stdio: ["ignore", "ignore", "inherit"] });
  built.push(file);
}

if (targets.includes("AppImage")) {
  const { runtime, mksquashfs } = appImageTools(arch);
  const appDir = join(work, "AppDir");
  cpSync(app, appDir, { recursive: true, verbatimSymlinks: true });
  rmSync(join(appDir, "chrome-sandbox"), { force: true });
  copyFileSync(join(appDir, "ardia"), join(appDir, "AppRun"));
  chmodSync(join(appDir, "AppRun"), 0o755);
  writeFileSync(join(appDir, "ardia.desktop"), desktopEntry.replaceAll("/opt/Ardia/ardia", "AppRun"));
  copyFileSync(join(iconSet, `${iconSizes[256]}.png`), join(appDir, "ardia.png"));
  copyFileSync(join(iconSet, `${iconSizes[256]}.png`), join(appDir, ".DirIcon"));
  const file = join(out, `${name}-${arch === "arm64" ? "arm64" : "x86_64"}.AppImage`);
  rmSync(file, { force: true });
  const runtimeData = readFileSync(runtime);
  execFileSync(mksquashfs, [appDir, file, "-offset", String(runtimeData.length), "-all-root", "-noappend", "-no-progress", "-quiet", "-no-xattrs", "-no-fragments", "-comp", "zstd", "-Xcompression-level", "19", "-b", "1048576"], { stdio: "inherit" });
  const fd = openSync(file, "r+");
  writeSync(fd, runtimeData, 0, runtimeData.length, 0);
  closeSync(fd);
  chmodSync(file, 0o755);
  built.push(file);
}

rmSync(work, { recursive: true, force: true });
for (const file of built) {
  const size = statSync(file).isDirectory() ? "" : ` (${(statSync(file).size / 1e6).toFixed(0)} MB)`;
  console.log(`${file}${size}`);
}
if (!ublock) console.log("note: --no-ublock: Extensions/ublock isn't in the package");
if (!hasSandbox) console.log("note: the engine has no chrome_sandbox: the .deb has no setuid helper (build chrome_sandbox, then 06-package.sh)");
