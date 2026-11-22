import { ardia, definePlugin } from "@ardia/plugin-sdk";
import { checkStars, closeTabs, decideTabOpening, omniboxSuggestions, pickTab, setDefaultRepo, setToken, tabSummary } from "./commands";
import { repoStats, toggleStar } from "./github";
import { RepoBrowser, ShowcaseSidebar, ToolbarPopover } from "./views";

type PageRequest = { type?: string; repo?: string; requestId?: string };

let visits = 0;

async function answerPage(message: unknown, view: string) {
  const request = (typeof message === "object" && message !== null ? message : {}) as PageRequest;
  const reply = (body: Record<string, unknown>) => ardia.pages.post(view, { requestId: request.requestId, ...body });
  try {
    if (request.type === "hello") return await reply({ type: "page", page: await ardia.tabs.activePage().catch(() => null), plugin: ardia.plugin, settings: ardia.settings.all() });
    if (request.type === "stats" && request.repo) return await reply({ type: "stats", stats: await repoStats(request.repo) });
    if (request.type === "star" && request.repo) return await reply({ type: "starred", starred: await toggleStar(request.repo) });
    await reply({ type: "error", message: `Unknown request ${String(request.type)}` });
  } catch (error) {
    await reply({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

void definePlugin({
  async activate() {
    await ardia.toolbar.update("showcase", { icon: "sparkles", label: null, badge: null, tooltip: "V2 Showcase" });
  },
  commands: {
    "pick-tab": pickTab,
    "close-tabs": closeTabs,
    "set-default-repo": setDefaultRepo,
    "set-token": setToken,
    "check-stars": checkStars,
    "tab-summary": tabSummary,
    "open-sidecar": () => ardia.panels.open("sidecar"),
  },
  tools: {
    "repo-stars": (input: { repo: string }) => repoStats(input.repo),
    "active-page": () => ardia.tabs.activePage(),
  },
  views: {
    sidebar: ShowcaseSidebar,
    "toolbar-popover": ToolbarPopover,
    "repo-browser": RepoBrowser,
  },
  omnibox: omniboxSuggestions,
  decide: {
    "tab.opening": decideTabOpening,
  },
  events: {
    "tab.activated": () => {
      visits++;
      if (ardia.settings.get("countVisits", true)) void ardia.toolbar.update("showcase", { label: visits > 0 ? `${visits}` : null });
    },
  },
  onPageMessage: (message, view) => void answerPage(message, view),
  onSettingsChange: (values) => {
    if (values.countVisits === false) void ardia.toolbar.update("showcase", { label: null });
  },
});
