import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

function playwrightHeadlessShell() {
  for (const cache of [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")]) {
    if (!existsSync(cache)) continue;
    for (const dir of readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse())
      for (const build of ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64", "chrome-headless-shell-linux64", "chrome-linux"]) {
        const path = join(cache, dir, build, build === "chrome-linux" ? "headless_shell" : "chrome-headless-shell");
        if (existsSync(path)) return path;
      }
  }
  return null;
}

function findChromium() {
  if (process.env.ARDIA_TEST_CHROMIUM && existsSync(process.env.ARDIA_TEST_CHROMIUM)) return process.env.ARDIA_TEST_CHROMIUM;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const shell = playwrightHeadlessShell();
  if (shell) return shell;
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => existsSync(path)) ?? null;
}

const chromiumPath = findChromium();

export const CHROMIUM_MISSING = chromiumPath === null && !process.env.CI && "no Chromium for Playwright (install Playwright's or set ARDIA_TEST_CHROMIUM)";

export const launchChromium = () => chromium.launch({ executablePath: chromiumPath, headless: true });
