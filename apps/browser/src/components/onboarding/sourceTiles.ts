import type { BrowserSourceId } from "../../state/onboarding/onboarding";
import type { PlatformFeatures } from "../../lib/platformFeatures";
import { t } from "../../lib/uiLanguage";


export type SourceCandidate = { id: Exclude<BrowserSourceId, "fresh">; name: string; app: string; importId?: string; onlyWhenFound?: boolean; listedOnly?: boolean };

export const SOURCE_CANDIDATES: SourceCandidate[][] = [
  [{ id: "arc", name: t(`Arc`), app: "/Applications/Arc.app" }],
  [{ id: "dia", name: t(`Dia`), app: "/Applications/Dia.app" }],
  [{ id: "chrome", name: t(`Chrome`), app: t(`/Applications/Google Chrome.app`) }],
  [
    { id: "safari", name: t(`Safari`), app: "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app" },
    { id: "safari", name: t(`Safari`), app: "/Applications/Safari.app" },
  ],
  [{ id: "firefox", name: t(`Firefox`), app: "/Applications/Firefox.app" }],
  [
    { id: "zen", name: t(`Zen`), app: "/Applications/Zen.app" },
    { id: "zen", name: t(`Zen`), app: t(`/Applications/Zen Browser.app`) },
    { id: "zen", name: t(`Zen Twilight`), app: t(`/Applications/Zen Twilight.app`) },
  ],
  [
    { id: "brave", name: t(`Brave`), app: t(`/Applications/Brave Browser.app`) },
    { id: "brave", name: t(`Brave Beta`), app: t(`/Applications/Brave Browser Beta.app`), importId: "braveBeta" },
    { id: "brave", name: t(`Brave Nightly`), app: t(`/Applications/Brave Browser Nightly.app`), importId: "braveNightly" },
    { id: "edge", name: t(`Edge`), app: t(`/Applications/Microsoft Edge.app`) },
    { id: "edge", name: t(`Edge Beta`), app: t(`/Applications/Microsoft Edge Beta.app`), importId: "edgeBeta" },
  ],
  [{ id: "helium", name: t(`Helium`), app: "/Applications/Helium.app", onlyWhenFound: true }],
  [{ id: "chromium", name: t(`Chromium`), app: "", onlyWhenFound: true, listedOnly: true }],
  [{ id: "vivaldi", name: t(`Vivaldi`), app: "", onlyWhenFound: true, listedOnly: true }],
  [{ id: "opera", name: t(`Opera`), app: "", onlyWhenFound: true, listedOnly: true }],
];

export type SourceTile = { id: BrowserSourceId; name: string; found: boolean; app: string | null; icon: string | null; importId?: string };

type Finding = Pick<PlatformFeatures, "findsBrowsersBy" | "hiddenBrowserSources">;

export function sourceTiles(isFound: (c: SourceCandidate) => boolean, platform: Finding): SourceTile[] {
  const keepsAppPaths = platform.findsBrowsersBy === "appBundle";
  const offered = SOURCE_CANDIDATES.filter((group) => !platform.hiddenBrowserSources.includes(group[0]!.id) && !(keepsAppPaths && group[0]!.listedOnly));
  return offered.flatMap((group): SourceTile[] => {
    const found = group.find(isFound);
    if (found) return [{ id: found.id, name: found.name, found: true, app: keepsAppPaths ? found.app : null, icon: null, importId: found.importId }];
    if (group.every((c) => c.onlyWhenFound)) return [];
    const names = [...new Set(group.filter((c) => !c.importId).map((c) => c.name))];
    const families = names.filter((name) => !names.some((other) => other !== name && name.startsWith(`${other} `)));
    return [{ id: group[0]!.id, name: families.join(t(` or `)), found: false, app: null, icon: null }];
  });
}
