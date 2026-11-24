import { ardia, useEffect, useState, type PluginTabInfo } from "@ardia/plugin-sdk";

export type RepoStats = {
  fullName: string;
  description: string;
  stars: number;
  forks: number;
  openIssues: number;
  language: string | null;
  url: string;
};

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const isRepoName = (value: string): boolean => REPO_NAME.test(value.trim());

export function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export function hostOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
  return match ? match[1]!.replace(/^www\./, "") : url;
}

export async function repoStats(repo: string): Promise<RepoStats> {
  const name = repo.trim();
  if (!isRepoName(name)) throw new Error(`${repo} isn't owner/name.`);
  const token = await ardia.secrets.get("githubToken");
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await ardia.net.fetch({ url: `https://api.github.com/repos/${name}`, headers, timeoutMs: 10_000 });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${name}.`);
  const data = response.json<Record<string, unknown>>();
  return {
    fullName: String(data.full_name ?? name),
    description: typeof data.description === "string" ? data.description : "",
    stars: Number(data.stargazers_count ?? 0),
    forks: Number(data.forks_count ?? 0),
    openIssues: Number(data.open_issues_count ?? 0),
    language: typeof data.language === "string" ? data.language : null,
    url: typeof data.html_url === "string" ? data.html_url : `https://github.com/${name}`,
  };
}

export async function starredRepos(): Promise<string[]> {
  return (await ardia.storage.get<string[]>("starred")) ?? [];
}

export async function toggleStar(repo: string): Promise<string[]> {
  const current = await starredRepos();
  const next = current.includes(repo) ? current.filter((r) => r !== repo) : [...current, repo];
  await ardia.storage.set("starred", next);
  return next;
}

export function useStarred(): [string[], (repo: string) => Promise<void>] {
  const [starred, setStarred] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void starredRepos().then((list) => live && setStarred(list));
    return () => {
      live = false;
    };
  }, []);
  return [starred, async (repo) => setStarred(await toggleStar(repo))];
}

export function useTabs(): PluginTabInfo[] | null {
  const [tabs, setTabs] = useState<PluginTabInfo[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => void ardia.tabs.query().then((list) => live && setTabs(list));
    load();
    const listeners = ["tab.opened", "tab.closed", "tab.activated"].map((name) => ardia.hooks.on(name, load));
    return () => {
      live = false;
      for (const listener of listeners) listener.dispose();
    };
  }, []);
  return tabs;
}

export function useRepo(repo: string | null): { stats: RepoStats | null; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ stats: RepoStats | null; error: string | null; loading: boolean }>({ stats: null, error: null, loading: false });
  useEffect(() => {
    if (!repo) return;
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    repoStats(repo).then(
      (stats) => live && setState({ stats, error: null, loading: false }),
      (error: unknown) => live && setState({ stats: null, error: error instanceof Error ? error.message : String(error), loading: false }),
    );
    return () => {
      live = false;
    };
  }, [repo]);
  return state;
}
