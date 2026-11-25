import { ardia, type CallContext, type OmniboxSuggestion, type QuickPickItem } from "@ardia/plugin-sdk";
import { formatCount, hostOf, isRepoName, repoStats, starredRepos } from "./github";

export async function pickTab(): Promise<{ tabId: string } | null> {
  const tabs = await ardia.tabs.query();
  const items: QuickPickItem[] = tabs.map((tab) => ({
    id: tab.id,
    title: tab.title || hostOf(tab.url),
    subtitle: hostOf(tab.url),
    icon: tab.pinned ? "pin.fill" : "globe",
    badge: tab.active ? "Current" : undefined,
    keywords: [hostOf(tab.url)],
  }));
  const picked = await ardia.ui.quickPick(items, { title: "Jump to a Tab", placeholder: "Search open tabs" });
  if (!picked) return null;
  await ardia.tabs.activate(picked.id);
  return { tabId: picked.id };
}

export async function closeTabs(): Promise<{ closed: number }> {
  const tabs = await ardia.tabs.query({ active: false, pinned: false });
  const picked = await ardia.ui.quickPick(
    tabs.map((tab) => ({ id: tab.id, title: tab.title || hostOf(tab.url), subtitle: hostOf(tab.url), icon: "globe" })),
    { title: "Close Tabs", placeholder: "Pick tabs to close", canPickMany: true },
  );
  if (!picked?.length) return { closed: 0 };
  const sure = await ardia.ui.confirm({ title: `Close ${picked.length} tabs?`, confirmTitle: "Close", destructive: true });
  if (!sure) return { closed: 0 };
  await ardia.workspace.apply([{ op: "tab.close", tabs: picked.map((item) => item.id) }]);
  await ardia.ui.toast(`Closed ${picked.length} tabs`, undefined, { icon: "xmark.circle", tone: "success" });
  return { closed: picked.length };
}

export async function setDefaultRepo(): Promise<string | null> {
  const value = await ardia.ui.inputBox({
    title: "Default repository",
    message: "The toolbar popover starts with this one.",
    placeholder: "owner/name",
    value: ardia.settings.get("defaultRepo", "nodejs/node"),
    confirmTitle: "Save",
  });
  if (value === undefined) return null;
  if (!isRepoName(value)) {
    await ardia.ui.toast(`${value} isn't owner/name`, "Use the owner/name form, like nodejs/node.", { icon: "exclamationmark.triangle", tone: "warning" });
    return null;
  }
  await ardia.storage.set("defaultRepo", value.trim());
  await ardia.ui.toast("Default repository saved", value.trim(), { icon: "checkmark.circle", tone: "success" });
  return value.trim();
}

export async function setToken(): Promise<{ saved: boolean }> {
  const token = await ardia.ui.inputBox({ title: "GitHub token", message: "Kept in your Keychain; only this plugin reads it.", password: true, confirmTitle: "Save" });
  if (token === undefined) return { saved: false };
  if (token === "") await ardia.secrets.delete("githubToken");
  else await ardia.secrets.set("githubToken", token);
  await ardia.ui.toast(token ? "Token saved" : "Token removed", undefined, { icon: "key", tone: "success" });
  return { saved: token !== "" };
}

export async function checkStars(input: { repo?: string } = {}): Promise<{ repo: string; stars: number }> {
  const repo = input.repo ?? ((await ardia.storage.get<string>("defaultRepo")) || ardia.settings.get("defaultRepo", "nodejs/node"));
  const stats = await repoStats(repo);
  await ardia.toolbar.update("showcase", { badge: formatCount(stats.stars), tooltip: `${stats.fullName} · ${stats.stars} stars` });
  await ardia.ui.toast(stats.fullName, `${formatCount(stats.stars)} stars`, { icon: "star.fill", tone: "accent" });
  return { repo: stats.fullName, stars: stats.stars };
}

export async function tabSummary(_input: unknown, call: CallContext): Promise<{ title: string; host: string } | null> {
  const tabId = typeof call.context.tabId === "string" ? call.context.tabId : null;
  const tabs = await ardia.tabs.query();
  const tab = tabs.find((t) => t.id === tabId) ?? tabs.find((t) => t.active);
  if (!tab) return null;
  await ardia.ui.toast(tab.title || "Untitled", hostOf(tab.url), { icon: "info.circle" });
  return { title: tab.title, host: hostOf(tab.url) };
}

export async function omniboxSuggestions(query: string): Promise<OmniboxSuggestion[]> {
  const typed = query.trim();
  const starred = await starredRepos();
  const matches = starred
    .filter((repo) => repo.toLowerCase().includes(typed.toLowerCase()))
    .slice(0, 5)
    .map((repo) => ({ title: repo, url: `https://github.com/${repo}`, subtitle: "Starred in V2 Showcase", icon: "star.fill", badge: "★" }));
  if (!typed) return matches;
  const direct: OmniboxSuggestion[] = isRepoName(typed) ? [{ title: `Open ${typed}`, url: `https://github.com/${typed}`, subtitle: "github.com", icon: "arrow.up.right.square" }] : [];
  const search = { title: `Search GitHub for “${typed}”`, url: `https://github.com/search?q=${encodeURIComponent(typed)}&type=repositories`, icon: "magnifyingglass" };
  return [...direct, ...matches.filter((m) => m.title !== typed), search];
}

export function blockedHosts(): string[] {
  return String(ardia.settings.get("blockedHosts", ""))
    .split(/[\s,]+/)
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

export function decideTabOpening(data: { url?: string }): { cancel: true } | null {
  if (!ardia.settings.get("focusGuard", false) || typeof data.url !== "string") return null;
  const host = hostOf(data.url).toLowerCase();
  const blocked = blockedHosts().some((entry) => host === entry || host.endsWith(`.${entry}`));
  return blocked ? { cancel: true } : null;
}
