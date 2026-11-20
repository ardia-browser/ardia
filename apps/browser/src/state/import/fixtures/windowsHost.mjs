import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsBrowsers } from "../../../../../../packages/expo-windows/src/import/browsers.ts";
import { fixtureHost } from "./importHost.mjs";

export const fixtures = fileURLToPath(new URL("../../../../../../packages/import/fixtures/", import.meta.url));
export const support = join(fixtures, "home/Library/Application Support");
export const LOCAL = "C:\\Users\\tester\\AppData\\Local";
export const ROAMING = "C:\\Users\\tester\\AppData\\Roaming";

const MOUNTS = [
  [`${LOCAL}\\Google\\Chrome\\User Data`, join(support, "Google/Chrome")],
  [`${LOCAL}\\BraveSoftware\\Brave-Browser\\User Data`, join(support, "BraveSoftware/Brave-Browser")],
  [`${LOCAL}\\BraveSoftware\\Brave-Browser-Beta\\User Data`, join(support, "BraveSoftware/Brave-Browser-Beta")],
  [`${LOCAL}\\Packages\\TheBrowserCompany.Arc_ttt1ap7aakyb4\\LocalCache\\Local\\Arc`, join(support, "Arc")],
  [`${ROAMING}\\Opera Software\\Opera Stable`, join(support, "com.operasoftware.Opera")],
  [`${ROAMING}\\Mozilla\\Firefox`, join(support, "Firefox")],
  [`${ROAMING}\\zen`, join(support, "zen")],
];

const onDisk = (windowsPath) => {
  for (const [prefix, folder] of MOUNTS) {
    if (windowsPath === prefix || windowsPath.startsWith(`${prefix}\\`)) return join(folder, ...windowsPath.slice(prefix.length).split("\\").filter(Boolean));
  }
  return null;
};

function within(folder, path, largest) {
  if (!path.startsWith(`${folder}\\`) || path.split("\\").includes("..")) return null;
  const file = onDisk(path);
  if (!file || !existsSync(file)) return null;
  const s = lstatSync(file);
  return s.isFile() && s.size <= largest ? file : null;
}

export const fakeHost = (secrets = {}) => fixtureHost({ platform: "Windows", separator: "\\", browsers: windowsBrowsers(LOCAL, ROAMING), onDisk, within }, secrets);
