import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const appcastPy = join(root, ".claude/skills/release/scripts/appcast.py");
const appcastSh = join(root, "scripts/release/appcast.sh");
const releases = "https://github.com/ardia-browser/ardia/releases/download";
const feedCheck = join(root, "scripts/release/feed-check.mjs");
const publicKey = Buffer.alloc(32, 7).toString("base64");
const sig = (content) => createHash("sha512").update(content).digest("base64");

function item({ version, build, channel, url, length = 100, signature = sig(url), deltas = [], deltasFirst = false }) {
  const main = `            <enclosure url="${url}" length="${length}" type="application/octet-stream" sparkle:edSignature="${signature}"/>\n`;
  const block = deltas.length
    ? "            <sparkle:deltas>\n" +
      deltas
        .map((d) => `                <enclosure url="${d.url}" sparkle:deltaFrom="${d.from}" length="${d.length}" type="application/octet-stream"${d.signature === undefined ? "" : ` sparkle:edSignature="${d.signature}"`}/>\n`)
        .join("") +
      "            </sparkle:deltas>\n"
    : "";
  return (
    "        <item>\n" +
    `            <title>${version}</title>\n` +
    (channel ? `            <sparkle:channel>${channel}</sparkle:channel>\n` : "") +
    `            <sparkle:version>${build}</sparkle:version>\n` +
    `            <sparkle:shortVersionString>${version}</sparkle:shortVersionString>\n` +
    (deltasFirst ? block + main : main + block) +
    "        </item>\n"
  );
}

function feed(items) {
  return (
    '<?xml version="1.0" standalone="yes"?>\n<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">\n    <channel>\n        <title>Ardia</title>\n' +
    items.map(item).join("") +
    "    </channel>\n</rss>\n"
  );
}

function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), `ac-appcast-${prefix}-`));
}

function py(...args) {
  const result = spawnSync("python3", ["-I", appcastPy, ...args], { encoding: "utf8" });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

const published = [
  { version: "0.3.1-nightly.2", build: 24, channel: "nightly", url: `${releases}/v0.3.1-nightly.2/Ardia-0.3.1-nightly.2.zip` },
  { version: "0.3.1-nightly.1", build: 23, channel: "nightly", url: `${releases}/v0.3.1-nightly.1/Ardia-0.3.1-nightly.1.zip` },
  { version: "0.3.0", build: 22, url: `${releases}/v0.3.0/Ardia-0.3.0.zip`, deltas: [{ from: 20, url: `${releases}/v0.3.0/Ardia22-20.delta`, length: 7, signature: "sig-old-delta" }] },
  { version: "0.3.0-nightly.1", build: 21, channel: "nightly", url: `${releases}/v0.3.0-nightly.1/Ardia-0.3.0-nightly.1.zip` },
  { version: "0.2.9", build: 20, url: `${releases}/v0.2.9/Ardia-0.2.9.zip` },
  { version: "0.2.8", build: 19, url: "https://example.com/elsewhere/Ardia-0.2.8.zip" },
  { version: "0.2.7", build: 18, url: `${releases}/v0.2.7/Ardia-0.2.7.zip` },
];

test("enclosure reads the zip's own enclosure, wherever the item lists its deltas", () => {
  const dir = scratch("enclosure");
  const deltas = [{ from: 21, url: `${releases}/v0.3.1/Ardia25-21.delta`, length: 9, signature: "sig-delta" }];
  for (const deltasFirst of [false, true]) {
    const path = join(dir, `feed-${deltasFirst}.xml`);
    writeFileSync(path, feed([{ version: "0.3.1", build: 25, url: `${releases}/v0.3.1/Ardia-0.3.1.zip`, length: 555, signature: "sig-zip", deltas, deltasFirst }]));
    const { status, out, err } = py("enclosure", path, "0.3.1");
    assert.equal(status, 0, err);
    assert.equal(out.trim(), "sig-zip 555");
  }
});

test("deltas lists each delta's from-build, url, length and signature, with - for a missing signature", () => {
  const path = join(scratch("deltas"), "feed.xml");
  writeFileSync(
    path,
    feed([
      {
        version: "0.3.1",
        build: 25,
        url: `${releases}/v0.3.1/Ardia-0.3.1.zip`,
        deltas: [
          { from: 24, url: `${releases}/v0.3.1/Ardia25-24.delta`, length: 11, signature: "sig-a" },
          { from: 22, url: `${releases}/v0.3.1/Ardia25-22.delta`, length: 12 },
        ],
      },
      published[0],
    ]),
  );
  const { status, out, err } = py("deltas", path, "0.3.1");
  assert.equal(status, 0, err);
  assert.deepEqual(out.trim().split("\n"), [`24 ${releases}/v0.3.1/Ardia25-24.delta 11 sig-a`, `22 ${releases}/v0.3.1/Ardia25-22.delta 12 -`]);
  assert.equal(py("deltas", path, "0.3.1-nightly.2").out, "", "an item without deltas lists none");
});

test("delta-bases: a stable builds deltas from earlier stables only, a nightly from the newest releases of either channel", () => {
  const path = join(scratch("bases"), "feed.xml");
  writeFileSync(path, feed(published));
  const stable = py("delta-bases", path, "0.3.1", "3");
  assert.equal(stable.status, 0, stable.err);
  assert.deepEqual(
    stable.out.trim().split("\n").map((line) => line.split(" ").slice(0, 2).join(" ")),
    [`22 ${releases}/v0.3.0/Ardia-0.3.0.zip`, `20 ${releases}/v0.2.9/Ardia-0.2.9.zip`],
    "the stable skips nightlies and the zip outside GitHub releases, and the cap counts the skipped one",
  );
  assert.match(stable.err, /skipped 0\.2\.8/);
  assert.ok(stable.out.split("\n")[0].endsWith(` 100 ${sig(`${releases}/v0.3.0/Ardia-0.3.0.zip`)}`), "length and signature come from the main enclosure, not the delta");
  const nightly = py("delta-bases", path, "0.3.1-nightly.3", "3");
  assert.deepEqual(
    nightly.out.trim().split("\n").map((line) => line.split(" ")[0]),
    ["24", "23", "22"],
  );
  assert.equal(py("delta-bases", path, "0.3.1", "0").out, "");
  assert.notEqual(py("delta-bases", path, "0.3.1", "x").status, 0);
});

test("delta-bases skips an earlier zip whose signature isn't strict base64 of 64 bytes, so nothing reaches a CLI as an option", () => {
  const path = join(scratch("bases-signature"), "feed.xml");
  const odd = (version, build, signature) => ({ version, build, url: `${releases}/v${version}/Ardia-${version}.zip`, signature });
  writeFileSync(path, feed([odd("0.3.0", 22, "-p"), odd("0.2.9", 20, "--ed-key-file=/tmp/k"), odd("0.2.8", 19, `${"A".repeat(86)}=`), odd("0.2.7", 18, `${sig("x").slice(0, 84)}!!==`), odd("0.2.6", 17, sig("ok"))]));
  const { status, out, err } = py("delta-bases", path, "0.3.1", "5");
  assert.equal(status, 0, err);
  assert.deepEqual(out.trim().split("\n").map((line) => line.split(" ")[0]), ["17"]);
  for (const version of ["0.3.0", "0.2.9", "0.2.8", "0.2.7"]) assert.match(err, new RegExp(`skipped ${version.replaceAll(".", "\\.")}`));
});

test("merge keeps the built item's deltas and every published item's deltas", () => {
  const dir = scratch("merge");
  const live = join(dir, "live.xml");
  const built = join(dir, "built.xml");
  const out = join(dir, "out.xml");
  writeFileSync(live, feed(published));
  const deltas = [{ from: 22, url: `${releases}/v0.3.1/Ardia25-22.delta`, length: 9, signature: "sig-new-delta" }];
  writeFileSync(built, feed([{ version: "0.3.1", build: 25, url: `${releases}/v0.3.1/Ardia-0.3.1.zip`, deltas }]));
  const merged = py("merge", live, built, "0.3.1", out);
  assert.equal(merged.status, 0, merged.err);
  assert.equal(py("deltas", out, "0.3.1").out.trim(), `22 ${releases}/v0.3.1/Ardia25-22.delta 9 sig-new-delta`);
  assert.equal(py("deltas", out, "0.3.0").out.trim(), `20 ${releases}/v0.3.0/Ardia22-20.delta 7 sig-old-delta`);
  assert.equal(py("check-above", out, "0.3.1").status, 0);
});

test("retarget points the zip's enclosure at the local copy and drops the deltas, which point at the real release", () => {
  const path = join(scratch("retarget"), "feed.xml");
  const deltas = [{ from: 22, url: `${releases}/v0.3.1/Ardia25-22.delta`, length: 9, signature: "sig-delta" }];
  writeFileSync(path, feed([{ version: "0.3.1", build: 25, url: `${releases}/v0.3.1/Ardia-0.3.1.zip`, length: 555, signature: "sig-zip", deltas, deltasFirst: true }]));
  const { status, out, err } = py("retarget", path, "0.3.1", "http://127.0.0.1:9/Ardia-0.3.1.zip", "777", "sig-local");
  assert.equal(status, 0, err);
  assert.doesNotMatch(out, /delta/);
  assert.match(out, /<enclosure url="http:\/\/127\.0\.0\.1:9\/Ardia-0\.3\.1\.zip" length="777" type="application\/octet-stream" sparkle:edSignature="sig-local"\/>/);
  const local = join(scratch("retarget-out"), "feed.xml");
  writeFileSync(local, out);
  assert.equal(py("enclosure", local, "0.3.1").out.trim(), "sig-local 777");
});

test("only keeps the version's item alone", () => {
  const dir = scratch("only");
  const path = join(dir, "feed.xml");
  writeFileSync(path, feed(published));
  assert.equal(py("only", path, "0.3.0", join(dir, "out.xml")).status, 0);
  const out = readFileSync(join(dir, "out.xml"), "utf8");
  assert.equal(out.match(/<item>/g).length, 1);
  assert.match(out, /<sparkle:shortVersionString>0\.3\.0</);
  assert.match(out, /<\/channel>\n<\/rss>\n$/);
});

const stubGenerateAppcast = `#!/usr/bin/env python3
import base64, hashlib, os, re, sys
sig = lambda data: base64.b64encode(hashlib.sha512(data).digest()).decode()
args = sys.argv[1:]
out = args[args.index("-o") + 1]
prefix = args[args.index("--download-url-prefix") + 1]
limit = int(args[args.index("--maximum-deltas") + 1])
folder = args[-1]
channel = args[args.index("--channel") + 1] if "--channel" in args else None
mode = os.environ.get("STUB_DELTAS", "make")
open(os.path.join(os.environ["STUB_LOG"], "generate_appcast.args"), "a").write("\\n".join(args) + "\\n--\\n")
if mode == "crash" and limit > 0:
    sys.exit(1)
zips = []
for name in os.listdir(folder):
    found = re.fullmatch(r"Ardia-(.+)\\.zip", name)
    if found:
        build = int(re.search(r"build=(\\d+)", open(os.path.join(folder, name)).read()).group(1))
        zips.append((build, found.group(1), name))
zips.sort(reverse=True)
items = []
for index, (build, version, name) in enumerate(zips):
    deltas = []
    if index == 0 and mode != "none":
        for old, _, _ in zips[1:1 + limit]:
            delta = f"Ardia{build}-{old}.delta"
            open(os.path.join(folder, delta), "w").write("d")
            signature = "" if mode == "unsigned" else f' sparkle:edSignature="{sig(b"forged" if mode == "badsig" else b"d")}"'
            deltas.append(f'<enclosure url="{prefix}{delta}" sparkle:deltaFrom="{old}" length="1" type="application/octet-stream"{signature}/>')
    size = os.path.getsize(os.path.join(folder, name))
    block = f"<sparkle:deltas>{''.join(deltas)}</sparkle:deltas>" if deltas else ""
    tag = f"<sparkle:channel>{channel}</sparkle:channel>" if channel else ""
    items.append(f'<item><title>{version}</title>{tag}<sparkle:version>{build}</sparkle:version><sparkle:shortVersionString>{version}</sparkle:shortVersionString><enclosure url="{prefix}{name}" length="{size}" type="application/octet-stream" sparkle:edSignature="{sig(open(os.path.join(folder, name), "rb").read())}"/>{block}</item>\\n')
open(out, "w").write('<?xml version="1.0"?>\\n<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">\\n<channel>\\n<title>Ardia</title>\\n' + "".join(items) + "</channel>\\n</rss>\\n")
`;

const stubEd25519 = `#!/usr/bin/env python3
import base64, hashlib, sys
command, path, signature, key = sys.argv[1:]
assert command == "verify"
with open(sys.argv[0] + ".log", "a") as log:
    log.write(path + "\\n")
sys.exit(0 if key == "${publicKey}" and signature == base64.b64encode(hashlib.sha512(open(path, "rb").read()).digest()).decode() else 1)
`;

const stubCurl = `#!/usr/bin/env bash
out="" url="" max=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    --max-time) max="$2"; shift ;;
    https://*) url="$1" ;;
  esac
  shift
done
echo "$url" >> "$STUB_LOG/curl.log"
echo "$max" >> "$STUB_LOG/curl-max-time.log"
if [ -n "\${STUB_CURL_STALL:-}" ]; then
  if [ -f "$STUB_LOG/curl-failed-once" ]; then
    sleep $(( STUB_CURL_STALL < max ? STUB_CURL_STALL : max ))
    exit 28
  fi
  touch "$STUB_LOG/curl-failed-once"
  exit 22
fi
source="$CURL_FIXTURES/\${url##*/}"
[ -f "$source" ] || exit 22
cp "$source" "$out"
`;

function harness({ version, build, base, fixtures = {}, appKey = publicKey }) {
  const dir = scratch("sh");
  const bin = join(dir, "bin");
  const sparkle = join(dir, "sparkle");
  const served = join(dir, "served");
  const dist = join(dir, "dist");
  const log = join(dir, "log");
  for (const path of [bin, sparkle, served, dist, log]) mkdirSync(path);
  const write = (path, text) => {
    writeFileSync(path, text);
    chmodSync(path, 0o755);
  };
  write(join(sparkle, "generate_appcast"), stubGenerateAppcast);
  write(join(bin, "ed25519"), stubEd25519);
  write(join(bin, "curl"), stubCurl);
  for (const [name, text] of Object.entries(fixtures)) writeFileSync(join(served, name), text);
  writeFileSync(join(dist, `Ardia-${version}.zip`), `build=${build}\n${"x".repeat(200)}`);
  mkdirSync(join(dist, "export/Ardia.app/Contents"), { recursive: true });
  writeFileSync(
    join(dist, "export/Ardia.app/Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${appKey ? `<key>SUPublicEDKey</key><string>${appKey}</string>` : ""}</dict></plist>\n`,
  );
  writeFileSync(join(dir, "body.md"), "Notes.\n");
  writeFileSync(join(dir, "key"), "key");
  const baseFeed = join(dir, "base.xml");
  writeFileSync(baseFeed, base ?? "");
  const summary = join(dir, "summary.md");
  writeFileSync(summary, "");
  return {
    dist,
    log,
    summary,
    run(env = {}) {
      const result = spawnSync("bash", [appcastSh, dist, version, "Headline", join(dir, "body.md"), baseFeed], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          SPARKLE_BIN: sparkle,
          SPARKLE_KEY_FILE: join(dir, "key"),
          APPCAST_ED25519: join(bin, "ed25519"),
          CURL_FIXTURES: served,
          STUB_LOG: log,
          GITHUB_ACTIONS: "",
          GITHUB_STEP_SUMMARY: summary,
          APPCAST_DELTAS: "",
          ...env,
        },
      });
      return { status: result.status, out: result.stdout + result.stderr };
    },
  };
}

function servedZips(items) {
  return Object.fromEntries(items.map((i) => [i.url.split("/").pop(), `build=${i.build}\n`]));
}

function lengthsMatch(items) {
  return items.map((i) => ({ ...i, length: `build=${i.build}\n`.length, signature: sig(`build=${i.build}\n`) }));
}

const zipsIn = (dist) => readdirSync(dist).filter((name) => name !== "export").sort();

test("appcast.sh: a stable with earlier stables downloads them, verifies them, and ships signed deltas from each", () => {
  const live = lengthsMatch(published);
  const h = harness({ version: "0.3.1", build: 25, base: feed(live), fixtures: servedZips(live) });
  const { status, out } = h.run({ GITHUB_ACTIONS: "true" });
  assert.equal(status, 0, out);
  assert.match(out, /PASS {2}2 signed Sparkle delta\(s\) for 0\.3\.1, from build\(s\) 22 20/);
  assert.deepEqual(zipsIn(h.dist), ["Ardia-0.3.1.zip", "Ardia25-20.delta", "Ardia25-22.delta", "appcast.xml"]);
  const verified = readFileSync(join(h.dist, "..", "bin", "ed25519.log"), "utf8");
  assert.match(verified, /Ardia-0\.3\.0\.zip/, "earlier zips are checked with the app's own key");
  assert.match(verified, /Ardia25-22\.delta/, "and so are the deltas");
  const curled = readFileSync(join(h.log, "curl.log"), "utf8").trim().split("\n");
  assert.deepEqual(curled, [`${releases}/v0.3.0/Ardia-0.3.0.zip`, `${releases}/v0.2.9/Ardia-0.2.9.zip`]);
  assert.match(readFileSync(join(h.log, "generate_appcast.args"), "utf8"), /--maximum-deltas\n2\n/);
  const xml = readFileSync(join(h.dist, "appcast.xml"), "utf8");
  assert.equal(xml.match(/<item>/g).length, published.length + 1, "every published item stays");
  assert.match(xml, new RegExp(`url="${releases}/v0\\.2\\.9/Ardia-0\\.2\\.9\\.zip"`), "earlier items keep their own release's URL");
  assert.match(readFileSync(h.summary, "utf8"), /Sparkle deltas: 2 \(from builds 22 20\)/);
});

test("appcast.sh: a nightly builds deltas from the newest releases of either channel", () => {
  const live = lengthsMatch(published);
  const h = harness({ version: "0.3.1-nightly.3", build: 25, base: feed(live), fixtures: servedZips(live) });
  const { status, out } = h.run();
  assert.equal(status, 0, out);
  assert.match(out, /from build\(s\) 24 23 22/);
  assert.match(readFileSync(join(h.dist, "appcast.xml"), "utf8"), /<sparkle:channel>nightly<\/sparkle:channel><sparkle:version>25</);
});

test("appcast.sh: no deltas although earlier zips were there warns, on a stable as on a nightly, and the release goes on", () => {
  const live = lengthsMatch(published);
  const stable = harness({ version: "0.3.1", build: 25, base: feed(live), fixtures: servedZips(live) });
  const shipped = stable.run({ STUB_DELTAS: "none", GITHUB_ACTIONS: "true" });
  assert.equal(shipped.status, 0, shipped.out);
  assert.match(shipped.out, /^::warning::generate_appcast made no delta for 0\.3\.1 from build\(s\) 22 20/m);
  assert.doesNotMatch(shipped.out, /::error::/);
  assert.ok(existsSync(join(stable.dist, "appcast.xml")));
  assert.match(readFileSync(stable.summary, "utf8"), /Sparkle deltas: none, although builds 22 20/);
  const nightly = harness({ version: "0.3.1-nightly.3", build: 25, base: feed(live), fixtures: servedZips(live) });
  const warned = nightly.run({ STUB_DELTAS: "none", GITHUB_ACTIONS: "true" });
  assert.equal(warned.status, 0, warned.out);
  assert.match(warned.out, /^::warning::generate_appcast made no delta for 0\.3\.1-nightly\.3/m);
  assert.match(readFileSync(nightly.summary, "utf8"), /Sparkle deltas: none, although builds 24 23 22/);
});

test("appcast.sh: earlier zips that don't download or don't match the feed only warn, even on a stable", () => {
  const live = lengthsMatch(published);
  const missing = harness({ version: "0.3.1", build: 25, base: feed(live) });
  const offline = missing.run();
  assert.equal(offline.status, 0, offline.out);
  assert.match(offline.out, /warning: couldn't download build 22/);
  assert.match(offline.out, /warning: none of the 2 earlier zips to build deltas from could be used/);
  assert.ok(existsSync(join(missing.dist, "appcast.xml")));

  for (const forged of ["build=22\ntampered\n", "build=27\n"]) {
    const tampered = harness({ version: "0.3.1", build: 25, base: feed(live), fixtures: { ...servedZips(live), "Ardia-0.3.0.zip": forged } });
    const partly = tampered.run();
    assert.equal(partly.status, 0, partly.out);
    assert.match(partly.out, /warning: build 22's zip .* doesn't match the length and EdDSA signature .* SUPublicEDKey/);
    assert.match(partly.out, /from build\(s\) 20$/m);
  }
});

test("appcast.sh: without the app's SUPublicEDKey no earlier zip is downloaded or used", () => {
  const live = lengthsMatch(published);
  const h = harness({ version: "0.3.1", build: 25, base: feed(live), fixtures: servedZips(live), appKey: null });
  const { status, out } = h.run();
  assert.equal(status, 0, out);
  assert.match(out, /warning: no SUPublicEDKey in the exported app/);
  assert.ok(!existsSync(join(h.log, "curl.log")));
  assert.match(readFileSync(h.summary, "utf8"), /Sparkle deltas: none \(the earlier zips can't be checked\)/);
});

test("appcast.sh: an earlier zip named like the new one never replaces it", () => {
  const clash = { version: "0.3.0", build: 22, url: `${releases}/v0.3.0-rebuilt/Ardia-0.3.1.zip` };
  const live = lengthsMatch([clash, published[4]]);
  const h = harness({ version: "0.3.1", build: 25, base: feed(live), fixtures: { "Ardia-0.3.1.zip": "build=22\n", "Ardia-0.2.9.zip": "build=20\n" } });
  const before = readFileSync(join(h.dist, "Ardia-0.3.1.zip"), "utf8");
  const { status, out } = h.run();
  assert.equal(status, 0, out);
  assert.match(out, /warning: build 22's zip is named Ardia-0\.3\.1\.zip, like a file already staged/);
  assert.equal(readFileSync(join(h.dist, "Ardia-0.3.1.zip"), "utf8"), before);
  assert.match(out, /from build\(s\) 20$/m);
  assert.doesNotMatch(readFileSync(join(h.log, "curl.log"), "utf8"), /Ardia-0\.3\.1\.zip/);
});

test("appcast.sh: with nothing published there are no deltas to build and nothing to warn about", () => {
  const h = harness({ version: "0.3.1", build: 25, base: "" });
  const { status, out } = h.run();
  assert.equal(status, 0, out);
  assert.match(out, /no published appcast to build deltas from/);
  assert.doesNotMatch(out, /warning/);
  const xml = readFileSync(join(h.dist, "appcast.xml"), "utf8");
  assert.equal(xml.match(/<item>/g).length, 1);
});

test("appcast.sh: a failed generate_appcast, an unsigned delta or one that doesn't verify only warns, and the appcast is built again from the new zip alone", () => {
  const live = lengthsMatch(published);
  for (const [mode, reason] of [
    ["crash", /generate_appcast failed with the earlier zips/],
    ["unsigned", /Ardia25-22\.delta has no well-formed sparkle:edSignature/],
    ["badsig", /Ardia25-22\.delta's EdDSA signature doesn't verify with the app's SUPublicEDKey/],
  ]) {
    const h = harness({ version: "0.3.1", build: 25, base: feed(live), fixtures: servedZips(live) });
    const { status, out } = h.run({ STUB_DELTAS: mode, GITHUB_ACTIONS: "true" });
    assert.equal(status, 0, `${mode}: ${out}`);
    assert.match(out, new RegExp(`^::warning::${reason.source}: 0\\.3\\.1 ships without deltas`, "m"), mode);
    assert.deepEqual(zipsIn(h.dist), ["Ardia-0.3.1.zip", "appcast.xml"], mode);
    const runs = readFileSync(join(h.log, "generate_appcast.args"), "utf8").split("--\n").filter(Boolean);
    assert.equal(runs.length, 2, mode);
    assert.match(runs[1], /--maximum-deltas\n0\n/, mode);
    assert.doesNotMatch(readFileSync(join(h.dist, "appcast.xml"), "utf8"), /Ardia25-/, mode);
    assert.equal(py("deltas", join(h.dist, "appcast.xml"), "0.3.1").out, "", mode);
    assert.match(readFileSync(h.summary, "utf8"), /Sparkle deltas: none \(/, mode);
  }
});

test("feed-check.mjs: an empty or broken live feed is not a feed, a whole one is", () => {
  const dir = scratch("feed-check");
  const check = (xml) => {
    const path = join(dir, `${Math.random()}.xml`);
    writeFileSync(path, xml);
    return spawnSync(process.execPath, [feedCheck, path, "0.3.1"], { encoding: "utf8" }).status;
  };
  assert.equal(check(feed(published)), 0);
  assert.equal(check(feed([])), 1, "an empty <channel>");
  assert.equal(check(""), 1);
  assert.equal(check("<rss><channel></channel></rss>"), 1);
  assert.equal(check(feed(published).replace("</channel>", "")), 1);
});

test("appcast.sh: APPCAST_DELTAS=0 ships without deltas, loudly", () => {
  const live = lengthsMatch(published);
  const h = harness({ version: "0.3.1", build: 25, base: feed(live), fixtures: servedZips(live) });
  const { status, out } = h.run({ APPCAST_DELTAS: "0" });
  assert.equal(status, 0, out);
  assert.match(out, /warning: APPCAST_DELTAS=0/);
  assert.ok(!existsSync(join(h.log, "curl.log")));
});

test("appcast.sh: earlier zips share one time budget, and running out only warns", () => {
  const live = lengthsMatch(published);
  const h = harness({ version: "0.3.1", build: 25, base: feed(live), fixtures: servedZips(live) });
  const { status, out } = h.run({ APPCAST_DELTA_FETCH_SECONDS: "0" });
  assert.equal(status, 0, out);
  assert.match(out, /warning: out of time for earlier zips \(APPCAST_DELTA_FETCH_SECONDS\): no delta from build 22/);
  assert.match(out, /warning: none of the 2 earlier zips to build deltas from could be used/);
  assert.ok(!existsSync(join(h.log, "curl.log")));
});

test("appcast.sh: a retry gets only what's left of the budget, so stalls can't overrun it", () => {
  const live = lengthsMatch(published);
  const h = harness({ version: "0.3.1", build: 25, base: feed(live), fixtures: servedZips(live) });
  const started = Date.now();
  const { status, out } = h.run({ APPCAST_DELTA_FETCH_SECONDS: "40", STUB_CURL_STALL: "15" });
  const seconds = (Date.now() - started) / 1000;
  assert.equal(status, 0, out);
  assert.ok(seconds < 40, `took ${seconds} s`);
  const limits = readFileSync(join(h.log, "curl-max-time.log"), "utf8").trim().split("\n").map(Number);
  assert.equal(limits.length, 2, `each attempt starts only with 30 s or more left: ${limits}`);
  assert.ok(limits[0] <= 40 && limits[1] <= limits[0] - 5, `the second attempt gets what's left: ${limits}`);
  assert.match(out, /warning: out of time for earlier zips/);
});
