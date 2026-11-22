import { readDocument, writeDocument } from "./documents";
import { switchOverride } from "./launchConfig";
import { t } from "../lib/uiLanguage";


type SwitchDef = {
  about: string;
  owner: string;
  removeBy: string;
  live: boolean;
};

type ExperimentDef = {
  about: string;
  owner: string;
  removeBy: string;
};

export const MAX_SWITCHES = 9;

export const SWITCHES = {
  newTabPrewarm: {
    about: t(`A New Tab page's engine tab is made a moment after it opens, so Enter only navigates it (state/tabs/prewarm.ts).`),
    owner: t(`command bar`),
    removeBy: "2026-12-15",
    live: true,
  },
  lazySidebarRows: {
    about: t(`A launch mounts only the sidebar rows its window shows, and the profile pages beside it a frame later (components/sidebar/SidebarPage.tsx).`),
    owner: "sidebar",
    removeBy: "2026-12-15",
    live: false,
  },
  updatePrewarm: {
    about: t(`An update staged for install-on-quit is run once, hidden, so its first launch skips macOS's first-exec checks (packages/shell UpdatePrewarm.swift).`),
    owner: "updater",
    removeBy: "2026-12-15",
    live: true,
  },
  launchTab: {
    about: t(`The focused window's page starts loading as the app starts, before its window is up (state/tabs/launchTab.ts).`),
    owner: "launch",
    removeBy: "2026-12-15",
    live: false,
  },
  lazyProfiles: {
    about: t(`A launch loads only the profiles its windows show; the others, and their extensions, load when first opened (state/profiles/profileLoading.ts).`),
    owner: "profiles",
    removeBy: "2027-01-15",
    live: false,
  },
  sidebarSlide: {
    about: t(`Hiding or showing the sidebar or the top tab strip (⌘S) slides it and the card's edge (Arc's motions and toolbar-less card with the address bar in the sidebar); off, they jump (components/window/SidebarDock.tsx).`),
    owner: "sidebar",
    removeBy: "2026-12-15",
    live: true,
  },
  sidebarSlideLean: {
    about: t(`The sidebar's slide draws the traffic lights' moves and lays them out once they stop (packages/shell ChromeWindows.swift).`),
    owner: "sidebar",
    removeBy: "2026-12-15",
    live: false,
  },
  serverWindowDrag: {
    about: t(`The window server moves the window from our drag areas in the title-bar band, so those drags tile, snap and cross displays as macOS's own, and our pointer-following loop holds AppKit's re-fits of the frames it places; off, every drag is the loop with AppKit's constrain, as before (packages/shell ServerWindowDrag.swift, WindowMove.swift).`),
    owner: "window",
    removeBy: "2026-12-15",
    live: false,
  },
  peekGenie: {
    about: t(`A Peek opens and closes with the Genie warp, a private Core Animation mesh; off, it zooms from the link and the mesh runtime is never inspected (packages/shell PeekStage.swift, ArdiaPeekMesh.m).`),
    owner: "peek",
    removeBy: "2027-02-15",
    live: true,
  },
} as const satisfies Record<string, SwitchDef>;

export const EXPERIMENTS = {
  freezeWatchOff: {
    about: t(`Turns off the freeze watch: the run-loop observers on the main and JavaScript threads that count stalls for perf_memory (packages/ardiacore ArdiaFreezeWatch.mm, state/telemetry/freezes.ts).`),
    owner: "perf",
    removeBy: "2027-02-28",
  },
  serverWindowDragAllOpen: {
    about: t(`With serverWindowDrag, every view in the titlebar band is also left open to window moves (a probe for the geometry work).`),
    owner: "window",
    removeBy: "2026-12-15",
  },
  dragRegionEveryMount: {
    about: t(`With serverWindowDrag, every React Native mount rebuilds each window's title-bar drag region, as it used to, instead of only the window whose title bar the pointer is in (packages/shell ServerWindowDrag.swift).`),
    owner: "window",
    removeBy: "2026-12-31",
  },
  officialPluginsAi: {
    about: t(`Lists the AI plugin as coming soon among the official plugins (state/plugins/official.ts), for Settings and onboarding.`),
    owner: "plugins",
    removeBy: "2027-03-31",
  },
} as const satisfies Record<string, ExperimentDef>;

type SwitchName = keyof typeof SWITCHES;
type ExperimentName = keyof typeof EXPERIMENTS;

const CACHE_DOC = "switches-cache.json";
const SWITCHES_URL = "https://ardia.dev/switches.json";
const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 4096;

type Values = Partial<Record<SwitchName, boolean>>;

const known = (name: string): name is SwitchName => Object.hasOwn(SWITCHES, name);

function parseSwitches(json: string | null | undefined): Values {
  const out: Values = {};
  try {
    const switches = (JSON.parse(json ?? "") as { switches?: Record<string, unknown> } | null)?.switches;
    if (switches && typeof switches === "object")
      for (const [name, value] of Object.entries(switches)) if (known(name) && typeof value === "boolean") out[name] = value;
  } catch {}
  return out;
}

let cached: Values = {};
let loaded = false;

function load() {
  loaded = true;
  try {
    cached = parseSwitches(readDocument(CACHE_DOC));
  } catch {
    cached = {};
  }
}

export function switchOn(name: SwitchName): boolean {
  if (!loaded) load();
  return switchOverride(name) ?? cached[name] ?? true;
}

export const experimentOn = (name: ExperimentName): boolean => switchOverride(name) ?? false;

export function reloadSwitches() {
  loaded = false;
  cached = {};
}

let fetchedThisLaunch = false;

type RefreshResult = "updated" | "failed" | "already";

export async function refreshSwitches(fetchFn: typeof fetch = fetch): Promise<RefreshResult> {
  if (fetchedThisLaunch) return "already";
  fetchedThisLaunch = true;
  if (!loaded) load();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchFn(SWITCHES_URL, { method: t(`GET`), credentials: "omit", cache: "no-store", signal: abort.signal });
    if (!response.ok) return "failed";
    const text = await response.text();
    if (text.length > MAX_BYTES) return "failed";
    const parsed = JSON.parse(text) as { version?: unknown; switches?: unknown };
    if (parsed?.version !== 1 || !parsed.switches || typeof parsed.switches !== "object") return "failed";
    const values = parseSwitches(text);
    writeDocument(CACHE_DOC, JSON.stringify({ version: 1, switches: values }));
    const next: Values = { ...cached };
    for (const name of Object.keys(SWITCHES) as SwitchName[]) if (SWITCHES[name].live) next[name] = values[name];
    cached = next;
    return "updated";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

export const resetRefreshForTests = () => void (fetchedThisLaunch = false);
