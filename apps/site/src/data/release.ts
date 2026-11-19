import release from "./release.json";
import { pagePath } from "./site";

export const VERSION = release.version;
export const DMG_SIZE = `${Math.round(release.dmgBytes / 1e6)} MB`;
export const REPO_SLUG = "mantrakp04/ardia";
export const REPO = `https://github.com/${REPO_SLUG}`;
export const TESTFLIGHT = "https://testflight.apple.com/join/yXHasDmr";
export const DISCORD = "https://discord.gg/TdhuXrbcA6";
export const RELEASES = `${REPO}/releases/latest`;
export const DMG = `${REPO}/releases/download/v${VERSION}/Ardia-${VERSION}.dmg`;
export const NIGHTLY = "/nightly";
export const INTEL_VERSION: string | null = "intel" in release && typeof release.intel === "string" ? release.intel : null;
export const INTEL_DMG = INTEL_VERSION ? `${REPO}/releases/download/v${INTEL_VERSION}/Ardia-${INTEL_VERSION}-x86_64.dmg` : null;
export const MAC_CHIPS = INTEL_DMG ? "Apple Silicon or Intel" : "Apple Silicon";
const DOWNLOADS = "https://github.com/ardia-browser/ardia/releases/download";
export const WINDOWS_SETUP = {
  x64: `${DOWNLOADS}/windows-alpha/Ardia-Setup-x64.exe`,
  arm64: `${DOWNLOADS}/windows-alpha/Ardia-Setup-arm64.exe`,
} as const;
export type WindowsArch = keyof typeof WINDOWS_SETUP;
export const LINUX_VERSION = release.linux;
export const LINUX_NIGHTLY = LINUX_VERSION.includes("-nightly.");
export const LINUX_TARBALL = `${DOWNLOADS}/v${LINUX_VERSION}/Ardia-${LINUX_VERSION}-linux-x64.tar.xz`;
export const MIN_MACOS_MAJOR = 14;
export const MIN_MACOS = `macOS ${MIN_MACOS_MAJOR} Sonoma`;
export const SENT_REFS = ["mac", "share", "email"] as const;
export type SentRef = (typeof SENT_REFS)[number];
export const sentPath = (ref: SentRef) => `${pagePath("home")}?ref=${ref}`;
export const sentLink = (ref: SentRef) => new URL(sentPath(ref), import.meta.env.SITE).href;
