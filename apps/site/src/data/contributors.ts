import { REPO_SLUG } from "./release";

export interface Contributor {
  readonly login: string;
  readonly avatar: string;
  readonly href: string;
  readonly contributions: number;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MIN_SHOWN = 3;
const AVATAR_PX = 112;

interface GithubContributor {
  login?: unknown;
  type?: unknown;
  avatar_url?: unknown;
  html_url?: unknown;
  contributions?: unknown;
}

const isPerson = (c: GithubContributor) => c.type === "User" && typeof c.login === "string" && !c.login.endsWith("[bot]");

function sizedAvatar(url: string) {
  const sized = new URL(url);
  sized.searchParams.set("s", String(AVATAR_PX));
  return sized.href;
}

async function fetchPage(page: number): Promise<GithubContributor[] | null> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO_SLUG}/contributors?per_page=${PAGE_SIZE}&page=${page}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ardia-site-build",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as GithubContributor[]) : null;
  } catch {
    return null;
  }
}

async function fetchContributors(): Promise<Contributor[]> {
  const people: Contributor[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await fetchPage(page);
    if (!batch) return page === 1 ? [] : people;
    for (const c of batch.filter(isPerson)) {
      if (typeof c.avatar_url !== "string" || typeof c.html_url !== "string") continue;
      people.push({
        login: c.login as string,
        avatar: sizedAvatar(c.avatar_url),
        href: c.html_url,
        contributions: typeof c.contributions === "number" ? c.contributions : 0,
      });
    }
    if (batch.length < PAGE_SIZE) break;
  }
  return people;
}

const fetched = await fetchContributors();

export const CONTRIBUTORS: readonly Contributor[] = fetched.length >= MIN_SHOWN ? fetched : [];
export const CONTRIBUTOR_AVATAR_PX = AVATAR_PX / 2;
