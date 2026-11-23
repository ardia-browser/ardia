import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DOC = "docs/privacy.md";

const SCANNED = [
  "apps/browser/src",
  "apps/browser/macos",
  "apps/browser/windows",
  "apps/browser/official-plugins.json",
  "apps/linux/src",
  "packages/ardiacore",
  "packages/core",
  "packages/core-rs",
  "packages/expo-windows",
  "packages/hostapi",
  "packages/import",
  "packages/plugin-broker",
  "packages/plugin-sdk",
  "packages/shaders",
  "packages/shell",
  "packages/sync",
  "engine/ardiacore/src",
  "engine/ardiacore-linux/src",
  "engine/chromium/src",
  "engine/patches",
  "scripts/windows/engine/src",
  "scripts/windows/engine/patches",
];

const NOT_SHIPPED = [
  /(^|\/)(tests?|__tests__|test-native|fixtures|selfCheck|probe|testdata)\//,
  /(^|\/)[^/]*-tests\//,
  /.\/scripts\//,
  /(^|\/)[^/]*Tests?\//,
  /\.(test|spec)\.[^/]+$/,
  /_test\.[^/]+$/,
  /(^|\/)engine\/patches\/build\//,
  /^packages\/core\/src\/bangList\.ts$/,
  /\.(md|lock|podspec|png|jpe?g|gif|ico|icns|webp|pak|zip|car|mp4|wasm|ttf|otf|woff2?|pdf)$/i,
  /(^|\/)(package|turbo|tsconfig[^/]*)\.json$/,
  /(^|\/)(THIRD_PARTY_NOTICES|LICENSE|NOTICE)[^/]*$/,
];

const RESERVED = /(^|\.)(example|test|invalid|localhost|local)$|^localhost$|^127(\.\d+){3}$|^0\.0\.0\.0$|^\[::1?\]$/i;
const BUNDLE_IDS = new Set(["com.microsoft.edgemac.dev", "com.brave.browser.dev", "com.google.chrome.dev"]);
const URL_CANDIDATE = /\b(?:https?|wss?):\/\/[^\s"'`<>(){}\\|^]+/giu;
const QUOTED_HOST = /["'`]((?:[a-z0-9-]+\.)+(?:com|net|org|dev|io|ai|so|tv|gov|edu|info|cloud|goog|app|xyz|site|online|tech|computer|services|network|systems|digital|blog|shop|biz|pro|cc|[a-z]{2}))["'`]/gi;
const FILE_SUFFIX = /\.(js|db|gz|sh|nm|py|rb|ts|md|mm|cc|rs|xz|7z)$|^[^.]+\.app$/i;
const NATIVE = /\.(cc|cpp|h|mm|m|swift|rs|patch)$/;

const read = (path) => readFileSync(join(ROOT, path), "utf8");

function shippedFiles() {
  const listed = execFileSync("git", ["-C", ROOT, "ls-files", "-z", "--", ...SCANNED], { encoding: "utf8", maxBuffer: 1 << 28 });
  return listed.split("\0").filter((path) => path && !NOT_SHIPPED.some((rule) => rule.test(path)));
}

function shippedText(path) {
  const text = read(path);
  if (!path.endsWith(".patch")) return text;
  const hunks = text.slice(Math.max(0, text.indexOf("\n@@")));
  return hunks
    .split("\n")
    .filter((line) => line.startsWith("+") || line.startsWith(" "))
    .filter((line) => !line.startsWith("+++"))
    .join("\n");
}

function removedLines(path) {
  const text = read(path);
  return text
    .slice(Math.max(0, text.indexOf("\n@@")))
    .split("\n")
    .filter((line) => line.startsWith("-") && !line.startsWith("---"))
    .join("\n");
}

const trimUrl = (text) => {
  const trimmed = text.replace(/[.,;:!?]+$/, "");
  return trimmed.endsWith("]") && !trimmed.includes("[") ? trimmed.slice(0, -1) : trimmed;
};

function urlHost(text) {
  let host = null;
  try {
    host = new URL(text.includes("://") ? text : `https://${text}/`).hostname;
  } catch {
    return null;
  }
  if (/[$*]/.test(host)) return null;
  const cut = host.match(/^(\[[0-9a-f:.]+\]|[a-z0-9_.-]+)/i)?.[1] ?? "";
  return cut.replace(/\.$/, "") || null;
}

function hostsInText(text, native) {
  const fromUrls = [...text.matchAll(URL_CANDIDATE)].map((m) => urlHost(trimUrl(m[0]))).filter((host) => host !== null);
  const quoted = native ? [...text.matchAll(QUOTED_HOST)].map((m) => m[1].toLowerCase()).filter((host) => !BUNDLE_IDS.has(host) && !FILE_SUFFIX.test(host)) : [];
  return [...fromUrls, ...quoted].filter((host) => !RESERVED.test(host));
}

const hostsIn = (path) => hostsInText(shippedText(path), NATIVE.test(path));

function section(doc, title) {
  const start = doc.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `${DOC} has a "## ${title}" section`);
  const end = doc.indexOf("\n## ", start + 1);
  return doc.slice(start, end < 0 ? undefined : end);
}

const ticked = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const looksLikeHost = (value) => (/^\[[0-9a-f:.]+\]$/i.test(value) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value)) && !/\.(md|ts|tsx|mjs|js|swift|mm|cc|h|py|sh|patch|json|plist|txt|ini)$/i.test(value);
const looksLikePath = (value) => /^[\w.@-]+(\/[\w.@-]+)+$/.test(value);

function tableRows(text) {
  const lines = text.split("\n").filter((line) => line.startsWith("|"));
  const header = lines[0]?.split("|").slice(1, -1).map((cell) => cell.trim()) ?? [];
  return lines.slice(2).map((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    return Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ""]));
  });
}

const doc = read(DOC);
const contacted = tableRows(section(doc, "Endpoints Ardia contacts"));
const named = section(doc, "Hosts named in the source that Ardia doesn't contact");
const singleLabel = named.split("\n").filter((line) => line.startsWith("- Single-label")).flatMap(ticked);
const disabled = tableRows(section(doc, "Google and Chromium endpoints that are off"));

test("every host hard-coded in Ardia's shipped sources, as a URL or as a quoted host in native and engine code, is listed in docs/privacy.md", () => {
  const listed = new Set([...[...contacted.flatMap((row) => ticked(row.Host)), ...ticked(named)].filter(looksLikeHost), ...singleLabel].map((host) => urlHost(host) ?? host));
  const files = shippedFiles();
  assert.ok(files.length > 1000, "the scan still finds the app's sources");
  const missing = new Map();
  for (const path of files)
    for (const host of hostsIn(path))
      if (!listed.has(host)) missing.set(host, [...(missing.get(host) ?? []), path]);
  const report = [...missing].map(([host, paths]) => `${host} (${[...new Set(paths)].slice(0, 3).join(", ")})`);
  assert.deepEqual(report, [], `add each host to ${DOC}: a row under "Endpoints Ardia contacts" if Ardia itself contacts it, else the "doesn't contact" list`);
});

test("each endpoint row names a host and cites code that still names it", () => {
  assert.ok(contacted.length >= 10, "the endpoint table still has its rows");
  for (const row of contacted) {
    const hosts = ticked(row.Host).filter(looksLikeHost);
    const code = ticked(row.Code).filter(looksLikePath);
    assert.ok(hosts.length || /user|plugin|page|from the/i.test(row.Host), `a row names its host: ${row.Host}`);
    assert.ok(code.length, `the ${row.Host} row cites the code that contacts it`);
    for (const path of code) assert.ok(existsSync(join(ROOT, path)), `${path}, cited for ${row.Host}, exists`);
    if (/Chromium's default/.test(row.Code)) continue;
    const text = code.map(read).join("\n").toLowerCase();
    for (const host of hosts) assert.ok(text.includes(host.toLowerCase()), `${host} is still named in ${code.join(" or ")}`);
  }
});

test("each disabled Google or Chromium endpoint cites a patch, switch or build argument whose shipped lines still hold its literal", () => {
  assert.ok(disabled.length >= 10, "the disabled-endpoint table still has its rows");
  for (const row of disabled) {
    const paths = ticked(row["Off by"]).filter(looksLikePath);
    const removes = [...row.Proof.matchAll(/removes `([^`]+)`/g)].map((m) => m[1]);
    const holds = ticked(row.Proof.replace(/removes `[^`]+`/g, ""));
    assert.ok(paths.length, `the ${row.Endpoint} row cites a file`);
    assert.ok(holds.length + removes.length, `the ${row.Endpoint} row gives the literal that proves it`);
    for (const path of paths) assert.ok(existsSync(join(ROOT, path)), `${path}, cited for ${row.Endpoint}, exists`);
    const shipped = shippedText(paths[0]);
    for (const literal of holds) assert.ok(shipped.includes(literal), `${paths[0]} still holds ${literal} (${row.Endpoint})`);
    const removed = removedLines(paths[0]);
    for (const literal of removes) assert.ok(removed.includes(literal) && !shipped.includes(literal), `${paths[0]} still removes ${literal} (${row.Endpoint})`);
  }
});

test("the scan reads hosts the way URL does, brackets, encodings and native quoted names included", () => {
  const cases = [
    ['const dns = "https://[2001:4860:4860::8888]";', "[2001:4860:4860::8888]"],
    ['fetch("https://[2001:db8::5]/x")', "[2001:db8::5]"],
    ['"https://tracking%2Evendor.com/v1"', "tracking.vendor.com"],
    ['"https://metrics\u3002vendor.com/v1"', "metrics.vendor.com"],
    ['"https://user:pw@Leak.Example.org.io:8080/"', "leak.example.org.io"],
    ['"https://trailing.vendor.io./x"', "trailing.vendor.io"],
    ['"https://intranet/x"', "intranet"],
  ];
  for (const [text, host] of cases) assert.deepEqual(hostsInText(text, false), [host], text);
  assert.deepEqual(hostsInText('@"tracker.vendor.network" @"api.service.co.uk" @"Ardia.app" @"com.google.chrome.dev"', true), ["tracker.vendor.network", "api.service.co.uk"]);
  assert.deepEqual(hostsInText("`https://www.${input}.com` https://*.example.com https://127.0.0.1:8080/", false), []);
});
