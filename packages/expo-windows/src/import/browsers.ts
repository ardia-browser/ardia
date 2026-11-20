import { joinPath, type Browser } from "@ardia/import/src/readers/index.ts";

type Root = "local" | "roaming";
type Listed = Omit<Browser, "dataDirectory"> & { root: Root; path: string };

const chromium = (id: string, name: string, path: string, root: Root = "local", rootIsProfile = false): Listed => ({
  id,
  name,
  family: "chromium",
  root,
  path,
  rootIsProfile,
});

const ARC_PACKAGE = "Packages\\TheBrowserCompany.Arc_ttt1ap7aakyb4\\LocalCache\\Local\\Arc\\User Data";

const LISTED: Listed[] = [
  chromium("chrome", "Google Chrome", "Google\\Chrome\\User Data"),
  chromium("edge", "Microsoft Edge", "Microsoft\\Edge\\User Data"),
  { id: "arc", name: "Arc", family: "arc", root: "local", path: ARC_PACKAGE, sidebar: "arc" },
  { id: "firefox", name: "Firefox", family: "firefox", root: "roaming", path: "Mozilla\\Firefox" },
  { id: "zen", name: "Zen", family: "firefox", root: "roaming", path: "zen", sidebar: "zen" },
  chromium("brave", "Brave", "BraveSoftware\\Brave-Browser\\User Data"),
  chromium("vivaldi", "Vivaldi", "Vivaldi\\User Data"),
  chromium("opera", "Opera", "Opera Software\\Opera Stable", "roaming", true),
  chromium("operaGX", "Opera GX", "Opera Software\\Opera GX Stable", "roaming", true),
  chromium("chromium", "Chromium", "Chromium\\User Data"),
  chromium("chromeBeta", "Google Chrome Beta", "Google\\Chrome Beta\\User Data"),
  chromium("chromeDev", "Google Chrome Dev", "Google\\Chrome Dev\\User Data"),
  chromium("chromeCanary", "Google Chrome Canary", "Google\\Chrome SxS\\User Data"),
  chromium("edgeBeta", "Microsoft Edge Beta", "Microsoft\\Edge Beta\\User Data"),
  chromium("edgeDev", "Microsoft Edge Dev", "Microsoft\\Edge Dev\\User Data"),
  chromium("edgeCanary", "Microsoft Edge Canary", "Microsoft\\Edge SxS\\User Data"),
  chromium("braveBeta", "Brave Beta", "BraveSoftware\\Brave-Browser-Beta\\User Data"),
  chromium("braveNightly", "Brave Nightly", "BraveSoftware\\Brave-Browser-Nightly\\User Data"),
];

export const windowsJoin = (...parts: string[]) => joinPath("\\", ...parts);

export function windowsBrowsers(localAppData: string, roamingAppData: string): Browser[] {
  return LISTED.map(({ root, path, ...browser }) => ({ ...browser, dataDirectory: windowsJoin(root === "local" ? localAppData : roamingAppData, path) }));
}
