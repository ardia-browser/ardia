#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const upstream = "apple/password-manager-resources";
const vendored = `${repo}/third_party/apple-password-manager-resources`;
const ardiaPath = `${repo}/packages/ardiacore/scripts/shared-credentials-ardia.json`;
const usage = `Refreshes the shared sign-in groups that password-manager ranking reads, from Apple's password-manager-resources.

  node packages/ardiacore/scripts/shared-credentials.mjs [ref]
  node packages/ardiacore/scripts/shared-credentials.mjs --local

With a ref (a branch, tag or commit of ${upstream}; default main), resolves it to a commit and downloads
quirks/shared-credentials.json and LICENSE.md at that commit into third_party/apple-password-manager-resources, with
source.json naming the commit. With --local, rebuilds from the copy already there.

Keeps every "shared" group (each domain's logins are offered on the others) and every "from" -> "to" entry one-way
(logins saved for a from domain are offered on a to domain, never the reverse); fromDomainsAreObsoleted doesn't
change that. shared-credentials-historical.json is left out: Apple marks it for reuse warnings, not suggestions.
Ardia's own entries, in the same format with a "why" each, live in packages/ardiacore/scripts/shared-credentials-ardia.json
and stay apart (ardiaText); the run fails once Apple's list names one of their domains, so the supplement is dropped then.
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

const compact = (list, name, allowed) => {
  const lines = [];
  let shared = 0;
  let oneWay = 0;
  list.forEach((entry, index) => {
    const where = `${name} entry ${index}`;
    const keys = Object.keys(entry).filter((key) => !allowed.has(key)).sort().join(",");
    if (keys === "shared") {
      const group = domains(entry.shared, `${where} shared`);
      if (group.length < 2) fail(`${where} shares only ${group[0]}`);
      lines.push(group.join(","));
      shared += 1;
    } else if (keys === "from,to" || keys === "from,fromDomainsAreObsoleted,to") {
      const from = domains(entry.from, `${where} from`);
      const to = domains(entry.to, `${where} to`);
      if (from.some((domain) => to.includes(domain))) fail(`${where} lists a domain on both sides`);
      lines.push(`${from.join(",")}>${to.join(",")}`);
      oneWay += 1;
    } else {
      fail(`${where} has keys ${keys}`);
    }
  });
  const joined = lines.join(";");
  if (/["\\\n]/.test(joined)) fail(`${name}'s compact form holds a character Swift would need escaped`);
  return { joined, shared, oneWay };
};

const apple = compact(entries, "apple", new Set());
const supplement = JSON.parse(readFileSync(ardiaPath, "utf8"));
if (!Array.isArray(supplement)) fail(`${ardiaPath} must hold a list`);
supplement.forEach((entry, index) => {
  if (typeof entry.why !== "string" || entry.why.trim() === "") fail(`ardia entry ${index} needs a why`);
});
const appleDomains = new Set(entries.flatMap((entry) => [...(entry.shared ?? []), ...(entry.from ?? []), ...(entry.to ?? [])]));
const ardia = compact(supplement, "ardia", new Set(["why"]));
const overlap = ardia.joined.split(/[;,>]/).filter((domain) => appleDomains.has(domain));
if (overlap.length) fail(`Apple's list now covers ${overlap.join(", ")}: drop it from ${ardiaPath}`);
writeFileSync(
  `${repo}/packages/ardiacore/ios/VaultSharedSitesData.swift`,
  `enum VaultSharedSitesData {\n  static let commit = "${source.commit}"\n  static let text = "${apple.joined}"\n  static let ardiaText = "${ardia.joined}"\n}\n`,
);
console.log(`shared-credentials: ${apple.shared} shared groups and ${apple.oneWay} one-way entries from ${upstream}@${source.commit}`);
console.log(`shared-credentials: ${ardia.shared} shared groups and ${ardia.oneWay} one-way entries from Ardia's supplement`);
