import { readGitHubJson, retryAtFrom, type GitHubJsonAnswer } from "../lib/appUpdate";

const GITHUB_HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

export async function fetchGitHubJson(url: string, signal: AbortSignal): Promise<GitHubJsonAnswer> {
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", headers: GITHUB_HEADERS, credentials: "omit", cache: "no-store", signal });
  } catch {
    return { kind: "unreachable" };
  }
  if (response.status === 404) return { kind: "missing" };
  if (response.status !== 200) return { kind: "refused", retryAt: retryAtFrom(response.status, (name) => response.headers.get(name), Date.now()) };
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { kind: "unreachable" };
  }
  const body = readGitHubJson(text);
  return body === undefined ? { kind: "refused", retryAt: null } : { kind: "json", body };
}

export type ChecksumAnswer = { kind: "text"; text: string } | { kind: "missing" } | { kind: "unreachable" };

const MAX_CHECKSUM_CHARS = 512;

export async function fetchReleaseChecksum(url: string, signal: AbortSignal): Promise<ChecksumAnswer> {
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", credentials: "omit", cache: "no-store", signal });
  } catch {
    return { kind: "unreachable" };
  }
  if (response.status === 404) return { kind: "missing" };
  if (response.status !== 200) return { kind: "unreachable" };
  try {
    const text = await response.text();
    return text.length > MAX_CHECKSUM_CHARS ? { kind: "missing" } : { kind: "text", text };
  } catch {
    return { kind: "unreachable" };
  }
}
