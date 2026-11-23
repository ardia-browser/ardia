#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const upstream = "apple/password-manager-resources";
const vendored = `${repo}/third_party/apple-password-manager-resources`;
const usage = `Refreshes the shared sign-in groups that password-manager ranking reads, from Apple's password-manager-resources.

  node packages/ardiacore/scripts/shared-credentials.mjs [ref]
  node packages/ardiacore/scripts/shared-credentials.mjs --local

With a ref (a branch, tag or commit of ${upstream}; default main), resolves it to a commit and downloads
quirks/shared-credentials.json and LICENSE.md at that commit into third_party/apple-password-manager-resources, with
source.json naming the commit. With --local, rebuilds from the copy already there.

Keeps every "shared" group (each domain's logins are offered on the others) and every "from" -> "to" entry one-way
(logins saved for a from domain are offered on a to domain, never the reverse); fromDomainsAreObsoleted doesn't
change that. shared-credentials-historical.json is left out: Apple marks it for reuse warnings, not suggestions.
Writes packages/ardiacore/ios/VaultSharedSitesData.swift.`;

const argument = process.argv[2];
if (argument === "-h" || argument === "--help") {
  console.log(usage);
  process.exit(0);
}

const fail = (message) => {
  throw new Error(`shared-credentials: ${message}`);
};

async function download(url, accept) {
  const response = await fetch(url, { headers: { "User-Agent": "shared-credentials-refresh", Accept: accept } });
  if (!response.ok) fail(`${url} answered ${response.status}`);
  return response.text();
}

if (argument !== "--local") {
  const ref = argument ?? "main";
  const commit = JSON.parse(await download(`https://api.github.com/repos/${upstream}/commits/${encodeURIComponent(ref)}`, "application/vnd.github+json"));
  const sha = commit.sha;
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) fail(`no commit for ${ref}`);
  const raw = (path) => download(`https://raw.githubusercontent.com/${upstream}/${sha}/${path}`, "text/plain");
  const [data, license] = await Promise.all([raw("quirks/shared-credentials.json"), raw("LICENSE.md")]);
  mkdirSync(vendored, { recursive: true });
  writeFileSync(`${vendored}/shared-credentials.json`, data);
  writeFileSync(`${vendored}/LICENSE.md`, license);
  const source = {
    repository: `https://github.com/${upstream}`,
    path: "quirks/shared-credentials.json",
    commit: sha,
    committed: commit.commit?.committer?.date ?? null,
    license: "MIT",
  };
  writeFileSync(`${vendored}/source.json`, `${JSON.stringify(source, null, 2)}\n`);
}

const source = JSON.parse(readFileSync(`${vendored}/source.json`, "utf8"));
const text = readFileSync(`${vendored}/shared-credentials.json`, "utf8");
const entries = JSON.parse(text);
if (!Array.isArray(entries) || entries.length < 50) fail(`expected a list of entries, got ${entries?.length}`);

const hostPattern = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const domains = (list, where) => {
  if (!Array.isArray(list) || list.length === 0) fail(`${where} must be a non-empty list`);
  const seen = new Set();
  return list.map((value) => {
    const domain = String(value).trim().toLowerCase().replace(/\.$/, "");
    if (!hostPattern.test(domain)) fail(`${where} has ${JSON.stringify(value)}, which isn't a host name`);
    if (seen.has(domain)) fail(`${where} lists ${domain} twice`);
    seen.add(domain);
    return domain;
  });
};

const lines = [];
let shared = 0;
let oneWay = 0;
entries.forEach((entry, index) => {
  const keys = Object.keys(entry).sort().join(",");
  if (keys === "shared") {
    const group = domains(entry.shared, `entry ${index} shared`);
    if (group.length < 2) fail(`entry ${index} shares only ${group[0]}`);
    lines.push(group.join(","));
    shared += 1;
  } else if (keys === "from,to" || keys === "from,fromDomainsAreObsoleted,to") {
    const from = domains(entry.from, `entry ${index} from`);
    const to = domains(entry.to, `entry ${index} to`);
    if (from.some((domain) => to.includes(domain))) fail(`entry ${index} lists a domain on both sides`);
    lines.push(`${from.join(",")}>${to.join(",")}`);
    oneWay += 1;
  } else {
    fail(`entry ${index} has keys ${keys}`);
  }
});

const joined = lines.join(";");
if (/["\\\n]/.test(joined)) fail("the compact form holds a character Swift would need escaped");
writeFileSync(
  `${repo}/packages/ardiacore/ios/VaultSharedSitesData.swift`,
  `enum VaultSharedSitesData {\n  static let commit = "${source.commit}"\n  static let text = "${joined}"\n}\n`,
);
console.log(`shared-credentials: ${shared} shared groups and ${oneWay} one-way entries from ${upstream}@${source.commit}`);
