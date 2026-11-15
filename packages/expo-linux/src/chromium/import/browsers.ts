import type { Family } from "./model";

export type Browser = {
  id: string;
  name: string;
  family: Family;
  paths: string[];
  rootIsProfile?: boolean;
  sidebar?: "arc" | "zen";
  keyring?: string;
  icons: string[];
};

const flatpak = (app: string, path: string) => `.var/app/${app}/${path}`;
const snap = (name: string, path: string) => `snap/${name}/${path}`;
const chromium = (id: string, name: string, paths: string[], keyring: string, icons: string[], rootIsProfile = false): Browser => ({ id, name, family: "chromium", paths, keyring, icons, rootIsProfile });
const firefoxLike = (id: string, name: string, paths: string[], icons: string[], sidebar?: "zen"): Browser => ({ id, name, family: "firefox", paths, icons, ...(sidebar ? { sidebar } : {}) });

export const BROWSERS: Browser[] = [
  chromium("chrome", "Google Chrome", [".config/google-chrome", flatpak("com.google.Chrome", "config/google-chrome")], "chrome", ["google-chrome", "com.google.Chrome"]),
  firefoxLike("firefox", "Firefox", [".mozilla/firefox", ".config/mozilla/firefox", snap("firefox", "common/.mozilla/firefox"), flatpak("org.mozilla.firefox", ".mozilla/firefox")], ["firefox", "org.mozilla.firefox", "firefox-esr"]),
  firefoxLike("zen", "Zen", [".zen", flatpak("app.zen_browser.zen", ".zen")], ["zen-browser", "zen", "app.zen_browser.zen"], "zen"),
  chromium("chromium", "Chromium", [".config/chromium", snap("chromium", "common/chromium"), flatpak("org.chromium.Chromium", "config/chromium")], "chromium", ["chromium", "chromium-browser", "org.chromium.Chromium"]),
  chromium("brave", "Brave", [".config/BraveSoftware/Brave-Browser", snap("brave", "current/.config/BraveSoftware/Brave-Browser"), flatpak("com.brave.Browser", "config/BraveSoftware/Brave-Browser")], "brave", ["brave-browser", "com.brave.Browser", "brave"]),
  chromium("edge", "Microsoft Edge", [".config/microsoft-edge", flatpak("com.microsoft.Edge", "config/microsoft-edge")], "Microsoft Edge", ["microsoft-edge", "com.microsoft.Edge"]),
  chromium("vivaldi", "Vivaldi", [".config/vivaldi", flatpak("com.vivaldi.Vivaldi", "config/vivaldi")], "vivaldi", ["vivaldi", "com.vivaldi.Vivaldi"]),
  chromium("opera", "Opera", [".config/opera", snap("opera", "current/.config/opera")], "opera", ["opera"], true),
  chromium("chromeBeta", "Google Chrome Beta", [".config/google-chrome-beta"], "chrome", ["google-chrome-beta"]),
  chromium("chromeDev", "Google Chrome Dev", [".config/google-chrome-unstable"], "chrome", ["google-chrome-unstable"]),
  chromium("edgeBeta", "Microsoft Edge Beta", [".config/microsoft-edge-beta"], "Microsoft Edge", ["microsoft-edge-beta"]),
  chromium("edgeDev", "Microsoft Edge Dev", [".config/microsoft-edge-dev"], "Microsoft Edge", ["microsoft-edge-dev"]),
  chromium("braveBeta", "Brave Beta", [".config/BraveSoftware/Brave-Browser-Beta"], "brave", ["brave-browser-beta"]),
  chromium("braveNightly", "Brave Nightly", [".config/BraveSoftware/Brave-Browser-Nightly"], "brave", ["brave-browser-nightly"]),
  chromium("vivaldiSnapshot", "Vivaldi Snapshot", [".config/vivaldi-snapshot"], "vivaldi", ["vivaldi-snapshot"]),
];

export const findBrowser = (id: string) => BROWSERS.find((b) => b.id === id);

export const isChromiumBased = (b: Browser) => b.family === "chromium" || b.family === "arc";
