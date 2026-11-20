import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { fixtureHost } from "./importHost.mjs";
import { support } from "./windowsHost.mjs";

export const HOME = "/home/tester/Library/Application Support";

const at = (path) => `${HOME}/${path}`;

export const POSIX_BROWSERS = [
  { id: "chrome", name: "Google Chrome", family: "chromium", dataDirectory: at("Google/Chrome"), rootIsProfile: false },
  { id: "arc", name: "Arc", family: "arc", dataDirectory: at("Arc/User Data"), sidebar: "arc" },
  { id: "firefox", name: "Firefox", family: "firefox", dataDirectory: at("Firefox") },
  { id: "zen", name: "Zen", family: "firefox", dataDirectory: at("zen"), sidebar: "zen" },
  { id: "brave", name: "Brave", family: "chromium", dataDirectory: at("BraveSoftware/Brave-Browser"), rootIsProfile: false },
  { id: "opera", name: "Opera", family: "chromium", dataDirectory: at("com.operasoftware.Opera"), rootIsProfile: true },
  { id: "braveBeta", name: "Brave Beta", family: "chromium", dataDirectory: at("BraveSoftware/Brave-Browser-Beta"), rootIsProfile: false },
];

const onDisk = (path) => {
  if (path !== HOME && !path.startsWith(`${HOME}/`)) return null;
  const rest = path.slice(HOME.length).split("/").filter(Boolean);
  return rest.includes("..") ? null : join(support, ...rest);
};

function within(folder, path, largest) {
  if (!path.startsWith(`${folder}/`)) return null;
  const file = onDisk(path);
  if (!file || !existsSync(file)) return null;
  const s = lstatSync(file);
  return s.isFile() && s.size <= largest ? file : null;
}

export const posixHost = (secrets = {}, platform = "Linux") => fixtureHost({ platform, separator: "/", browsers: POSIX_BROWSERS, onDisk, within }, secrets);
