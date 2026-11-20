#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { domainToASCII } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const usage = `Regenerates the Public Suffix List rules that password-manager site matching reads.

  node packages/ardiacore/scripts/public-suffixes.mjs [public_suffix_list.dat]

Reads the list (default: the copy in apps/android/blocking, which the blocking build keeps current), turns every
rule into ASCII (punycode), groups the rules by top-level label (tld:prefix,prefix;...), keeps the ICANN and private sections with their wildcards (*.) and exceptions (!), and
writes the same rule text to packages/ardiacore/ios/VaultPublicSuffixRules.swift and
apps/browser/src/state/vaults/suffixes.ts.`;

const argument = process.argv[2];
if (argument === "-h" || argument === "--help") {
  console.log(usage);
  process.exit(0);
}

const source = resolve(argument ?? `${repo}/apps/android/blocking/src/main/resources/com/ardia/blocking/public_suffix_list.dat`);
const text = readFileSync(source, "utf8");
const version = text.match(/^\/\/ VERSION: (\S+)/m)?.[1] ?? "unknown";

const asciiRule = (line) => {
  const marker = line.startsWith("!") ? "!" : line.startsWith("*.") ? "*." : "";
  const rest = line.slice(marker.length);
  const ascii = domainToASCII(rest);
  if (!ascii) throw new Error(`public-suffixes: can't convert rule ${line}`);
  return marker + ascii.toLowerCase();
};

const rules = [];
const seen = new Set();
for (const raw of text.split("\n")) {
  const line = raw.trim().split(/\s/)[0];
  if (!line || line.startsWith("//")) continue;
  const rule = asciiRule(line);
  if (seen.has(rule)) continue;
  seen.add(rule);
  rules.push(rule);
}
if (rules.length < 5000) throw new Error(`public-suffixes: only ${rules.length} rules in ${source}`);

const groups = new Map();
for (const rule of rules) {
  const body = rule.replace(/^[!*]\.?/, "");
  const tld = body.slice(body.lastIndexOf(".") + 1);
  const prefix = rule === tld ? "" : rule.slice(0, rule.length - tld.length - 1);
  if (!groups.has(tld)) groups.set(tld, []);
  groups.get(tld).push(prefix);
}
const joined = [...groups].map(([tld, prefixes]) => `${tld}:${prefixes.join(",")}`).join(";");
const expanded = joined.split(";").flatMap((group) => {
  const [tld, list] = group.split(":");
  return list.split(",").map((prefix) => (prefix ? `${prefix}.${tld}` : tld));
});
if (expanded.length !== rules.length || expanded.some((rule) => !seen.has(rule))) throw new Error("public-suffixes: the compact form doesn't read back");
writeFileSync(
  `${repo}/packages/ardiacore/ios/VaultPublicSuffixRules.swift`,
  `enum VaultPublicSuffixRules {\n  static let version = "${version}"\n  static let text = "${joined}"\n}\n`,
);
writeFileSync(
  `${repo}/apps/browser/src/state/vaults/suffixes.ts`,
  `export const PUBLIC_SUFFIX_VERSION = "${version}";\nexport const PUBLIC_SUFFIX_RULES = "${joined}";\n`,
);
console.log(`public-suffixes: ${rules.length} rules from ${version} (${Math.round(joined.length / 1024)} KB)`);
