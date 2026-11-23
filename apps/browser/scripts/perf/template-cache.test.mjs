import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloneTree, componentDrift, copyCachedTemplate, defaultCacheDir, pruneCache, sourceChanged, storePair, entryProblems, keyId, keyProblems, lookupTemplate, storeTemplate, templateKey, uboVersion } from "./template-cache.mjs";
import { componentsMismatch, componentsState, jointProblems } from "./template-state.mjs";
import { UBO_ID } from "./ubo-cache.mjs";

const MB = 1048576;
const HOUR = 3600_000;
const identity = { version: "0.2.48", build: "139", cdhash: "ab12", ubo: "1.62.0" };
const key = templateKey({ identity, bundleSha: "beef", pagePort: 9476 });
const components = { CertificateRevocation: { version: "10918", checked: true }, PKIMetadata: { version: "1839", checked: true } };

const withDir = (fn) => async () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-template-cache-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

function fakeTemplate(dir, { storeMB = 34, blobsMB = 21 } = {}) {
  const store = join(dir, "Chromium", "Default", "Local Extension Settings", UBO_ID);
  const blobs = join(dir, "Chromium", "Default", "IndexedDB", `chrome-extension_${UBO_ID}_0.indexeddb.blob`, "1");
  mkdirSync(store, { recursive: true });
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(store, "000003.ldb"), Buffer.alloc(storeMB * MB));
  writeFileSync(join(store, "000004.log"), "x");
  writeFileSync(join(blobs, "1"), Buffer.alloc(blobsMB * MB));
  writeFileSync(join(dir, "session.json"), "{}");
  return { sizes: { uboStoreMB: storeMB + 1 / MB, uboBlobsMB: blobsMB, uboLogMB: 1 / MB }, components };
}

test("the key covers the app build, its code and uBO, the bench bundle and the page port, and any change gives another id", () => {
  assert.deepEqual(Object.keys(key).sort(), ["build", "bundleSha", "cdhash", "pagePort", "recipe", "revision", "ubo", "version"]);
  const ids = new Set([key, { ...key, build: "140" }, { ...key, cdhash: "cd34" }, { ...key, ubo: "1.63.0" }, { ...key, bundleSha: "f00d" }, { ...key, pagePort: 9477 }, { ...key, revision: key.revision + 1 }].map(keyId));
  assert.equal(ids.size, 7);
  assert.equal(keyId({ ...key }), keyId(Object.fromEntries(Object.entries(key).reverse())));
});

test("a key with an unknown part isn't cached: a random page port, an unsigned app or a missing uBO", () => {
  assert.deepEqual(keyProblems(key), []);
  assert.deepEqual(keyProblems({ ...key, pagePort: 0 }), ["the key's pagePort is unknown"]);
  assert.deepEqual(keyProblems({ ...key, cdhash: null, ubo: undefined }), ["the key's cdhash is unknown", "the key's ubo is unknown"]);
});

test("an entry is refused when any key part changed, when it is too old, or when its record or files are off", () => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  const record = { sizes: { uboStoreMB: 34, uboBlobsMB: 21, uboLogMB: 0 }, components };
  const entry = { key, made: new Date(now - 2 * HOUR).toISOString(), record };
  assert.deepEqual(entryProblems(entry, key, { now }), []);
  assert.match(entryProblems(entry, { ...key, build: "140" }, { now }).join(), /build changed \(139 → 140\)/);
  assert.match(entryProblems(entry, { ...key, ubo: "1.63.0" }, { now }).join(), /ubo changed/);
  assert.match(entryProblems({ ...entry, made: new Date(now - 13 * HOUR).toISOString() }, key, { now }).join(), /13\.0 h old, over 12 h/);
  assert.deepEqual(entryProblems({ ...entry, made: new Date(now - 13 * HOUR).toISOString() }, key, { now, maxAgeHours: 24 }), []);
  assert.match(entryProblems({ ...entry, made: new Date(now + HOUR).toISOString() }, key, { now }).join(), /no valid date/);
  assert.match(entryProblems({ ...entry, record: { ...record, sizes: { ...record.sizes, uboStoreMB: 3 } } }, key, { now }).join(), /uBO's store is 3\.0 MB/);
  assert.match(entryProblems({ ...entry, record: { ...record, components: { PKIMetadata: { version: null } } } }, key, { now }).join(), /PKIMetadata isn't installed/);
  assert.match(entryProblems(entry, key, { now, sizes: { ...record.sizes, uboBlobsMB: 20 } }).join(), /files changed/);
  assert.deepEqual(entryProblems(null, key), ["no cached template"]);
});

test("store then look up: a hit copies the very template back, and a new build, a stale entry or an edited file misses", withDir((dir) => {
  const cache = join(dir, "cache");
  const made = join(dir, "made");
  const record = fakeTemplate(made);
  const now = Date.now();
  storeTemplate(cache, key, made, record, { now: now - HOUR });
  const hit = lookupTemplate(cache, key, { now });
  assert.equal(hit.hit, true, hit.problems?.join());
  const into = join(dir, "side", "template");
  copyCachedTemplate(hit, into);
  assert.equal(lookupTemplate(join(dir, "nothing"), key).hit, false);
  assert.deepEqual(lookupTemplate(cache, { ...key, build: "140" }).problems, ["no cached template"]);
  assert.match(lookupTemplate(cache, key, { now: now + 12 * HOUR }).problems.join(), /over 12 h/);
  writeFileSync(join(hit.template, "Chromium", "Default", "Local Extension Settings", UBO_ID, "000005.ldb"), Buffer.alloc(MB));
  assert.match(lookupTemplate(cache, key, { now }).problems.join(), /files changed/);
  storeTemplate(cache, key, made, record, { now });
  assert.equal(lookupTemplate(cache, key, { now }).hit, true);
}));

test("templates of a release build live with it in dist; anything else in the bench's out dir", () => {
  assert.equal(defaultCacheDir("/r/dist/0.2.48/export/Ardia.app", "/o"), "/r/dist/0.2.48/bench/templates");
  assert.equal(defaultCacheDir("/r/dist/0.2.49-rc/export/Ardia.app", "/o"), "/r/dist/0.2.49-rc/bench/templates");
  assert.equal(defaultCacheDir("/tmp/dl/Ardia.app", "/o"), "/o/.templates");
  assert.equal(defaultCacheDir("/r/build/export/Ardia.app", "/o"), "/o/.templates");
});

test("uBO's version comes from the bundled extension's manifest", withDir((dir) => {
  assert.equal(uboVersion(join(dir, "Ardia.app")), null);
  mkdirSync(join(dir, "Ardia.app/Contents/Resources/Extensions/ublock"), { recursive: true });
  writeFileSync(join(dir, "Ardia.app/Contents/Resources/Extensions/ublock/manifest.json"), JSON.stringify({ version: "1.62.0" }));
  assert.equal(uboVersion(join(dir, "Ardia.app")), "1.62.0");
}));

test("the two sides' templates must carry the same startup component versions", () => {
  assert.deepEqual(componentsMismatch([{ components }, { components }]), []);
  assert.deepEqual(componentsMismatch([{ components }]), []);
  assert.deepEqual(componentsMismatch([{ components }, { components: { ...components, CertificateRevocation: { version: "10920" } } }]), ["component CertificateRevocation differs (10918 vs 10920)"]);
});

test("xbench's templates carry their own check (a restored page) and extra key parts, and skip the size check when there's no uBO", withDir((dir) => {
  const cache = join(dir, "cache");
  const made = join(dir, "made");
  mkdirSync(join(made, "home"), { recursive: true });
  const xkey = templateKey({ identity: { ...identity, ubo: "none" }, bundleSha: "none", pagePort: 9462, recipe: "xbench-dia", harness: 1, launchTab: "on", window: "40,80", screen: 1117, env: "none" });
  assert.deepEqual(keyProblems(xkey), []);
  assert.notEqual(keyId(xkey), keyId({ ...xkey, window: "0,0" }));
  const validate = (record) => (record?.pages?.length ? [] : ["it restores no page"]);
  storeTemplate(cache, xkey, made, { pages: ["http://127.0.0.1:9462/static?id=seed"], sizes: null });
  assert.equal(lookupTemplate(cache, xkey, { validate, sizesOf: () => null }).hit, true);
  storeTemplate(join(dir, "other"), xkey, made, { pages: [], sizes: null });
  assert.deepEqual(lookupTemplate(join(dir, "other"), xkey, { validate, sizesOf: () => null }).problems, ["it restores no page"]);
}));

const installAll = (dir) => {
  for (const [folder, version] of [["CertificateRevocation", "10918"], ["PKIMetadata", "1839"]]) {
    mkdirSync(join(dir, "Chromium", folder, version), { recursive: true });
    writeFileSync(join(dir, "Chromium", folder, version, "manifest.json"), "{}");
  }
};
const installed = { componentsOf: (d) => componentsState(d).components };

test("a stored generation is never changed: a reader copies the one it checked even when a writer stores a newer one meanwhile", withDir((dir) => {
  const cache = join(dir, "cache");
  const a = join(dir, "a"), b = join(dir, "b");
  const recordA = fakeTemplate(a);
  writeFileSync(join(a, "generation"), "A");
  storeTemplate(cache, key, a, recordA, { now: Date.now() - 1000 });
  const hit = lookupTemplate(cache, key);
  assert.equal(hit.hit, true);
  const recordB = fakeTemplate(b);
  writeFileSync(join(b, "generation"), "B");
  storeTemplate(cache, key, b, recordB);
  copyCachedTemplate(hit, join(dir, "dest"));
  assert.equal(readFileSync(join(dir, "dest", "generation"), "utf8"), "A");
  assert.equal(readFileSync(join(lookupTemplate(cache, key).template, "generation"), "utf8"), "B");
}));

test("a hit re-reads the installed startup components, before the copy and on the copy", withDir((dir) => {
  const cache = join(dir, "cache");
  const made = join(dir, "made");
  const record = fakeTemplate(made);
  installAll(made);
  storeTemplate(cache, key, made, record);
  const hit = lookupTemplate(cache, key, installed);
  assert.equal(hit.hit, true, hit.problems?.join());
  rmSync(join(hit.template, "Chromium", "PKIMetadata"), { recursive: true, force: true });
  assert.match(lookupTemplate(cache, key, installed).problems.join(), /component PKIMetadata is missing, recorded 1839/);
  const copied = copyCachedTemplate(hit, join(dir, "dest"), installed);
  assert.equal(copied.ok, false);
  assert.match(copied.problems.join(), /PKIMetadata is missing/);
  assert.deepEqual(componentDrift(components, { CertificateRevocation: { version: "10918" }, PKIMetadata: { version: "1840" } }), ["component PKIMetadata is 1840, recorded 1839"]);
}));

test("each side's entry remembers the pair it was made with", withDir((dir) => {
  const made = join(dir, "made");
  const record = fakeTemplate(made);
  storeTemplate(join(dir, "cache"), key, made, record, { pair: "p1" });
  assert.equal(lookupTemplate(join(dir, "cache"), key).entry.pair, "p1");
}));

test("the clone works where cp has no -c (GNU cp on Linux CI)", withDir((dir) => {
  mkdirSync(join(dir, "from", "sub"), { recursive: true });
  writeFileSync(join(dir, "from", "sub", "f"), "x");
  cloneTree(join(dir, "from"), join(dir, "to"));
  assert.equal(readFileSync(join(dir, "to", "sub", "f"), "utf8"), "x");
}));

test("prepared copies made from an older build of the same path are refused, so a rebuilt candidate is prepared again", () => {
  assert.deepEqual(sourceChanged(identity, { ...identity }), []);
  assert.deepEqual(sourceChanged(identity, { ...identity, build: "140", cdhash: "cd34" }), ["its build is 140, the copy was made from 139", "its cdhash is cd34, the copy was made from ab12"]);
  assert.deepEqual(sourceChanged(undefined, identity), []);
});

test("a generation removed before or during the copy is a miss, not an abort", withDir((dir) => {
  const made = join(dir, "made");
  const record = fakeTemplate(made);
  storeTemplate(join(dir, "cache"), key, made, record);
  const hit = lookupTemplate(join(dir, "cache"), key);
  rmSync(hit.dir, { recursive: true, force: true });
  const copied = copyCachedTemplate(hit, join(dir, "dest"));
  assert.equal(copied.ok, false);
  assert.equal(existsSync(join(dir, "dest")), false);
}));

test("storing prunes expired generations of every key and abandoned staging folders, and keeps fresh ones", withDir((dir) => {
  const cache = join(dir, "cache");
  const made = join(dir, "made");
  const record = fakeTemplate(made);
  const now = Date.now();
  const other = { ...key, build: "140" };
  const old = storeTemplate(cache, other, made, record, { now: now - 25 * HOUR });
  const fresh = storeTemplate(cache, other, made, record, { now: now - HOUR });
  const otherDir = join(cache, keyId(other));
  mkdirSync(join(otherDir, `.staging-${now - 3 * HOUR}-1-aaaaaaaa`), { recursive: true });
  mkdirSync(join(otherDir, `.staging-${now - 60_000}-2-bbbbbbbb`), { recursive: true });
  storeTemplate(cache, key, made, record, { now });
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
  assert.deepEqual(readdirSync(otherDir).filter((n) => n.startsWith(".staging-")), [`.staging-${now - 60_000}-2-bbbbbbbb`]);
  assert.deepEqual(pruneCache(join(dir, "nothing")), []);
}));

test("a store that fails partway leaves no staging folder behind", withDir((dir) => {
  const cache = join(dir, "cache");
  assert.throws(() => storeTemplate(cache, key, join(dir, "does-not-exist"), {}));
  assert.deepEqual(readdirSync(join(cache, keyId(key))), []);
}));

test("a pair that fails the joint check is never cached; a matching pair is stored together", withDir((dir) => {
  const made = join(dir, "made");
  const record = fakeTemplate(made);
  const entries = [key, { ...key, build: "127" }].map((k) => ({ cacheDir: join(dir, "cache"), key: k, templateDir: made, record }));
  const mismatched = jointProblems([{ ...record, components }, { ...record, components: { ...components, PKIMetadata: { version: "1840" } } }]);
  assert.match(mismatched.join(), /component PKIMetadata differs/);
  assert.deepEqual(storePair(entries, mismatched), []);
  assert.equal(existsSync(join(dir, "cache")), false);
  const stored = storePair(entries, jointProblems([record, record]));
  assert.equal(stored.length, 2);
  const pairs = entries.map((e) => lookupTemplate(e.cacheDir, e.key).entry.pair);
  assert.equal(pairs[0], pairs[1]);
  assert.ok(pairs[0]);
  assert.match(jointProblems([record, { ...record, sizes: { ...record.sizes, uboStoreMB: record.sizes.uboStoreMB * 1.5 } }]).join(), /uBO stores differ/);
}));

test("pruning renames a generation out of the lookup path before deleting it, so a reader can't take a half-deleted one", withDir((dir) => {
  const cache = join(dir, "cache");
  const made = join(dir, "made");
  const record = fakeTemplate(made);
  const now = Date.now();
  const old = storeTemplate(cache, key, made, record, { now: now - 25 * HOUR });
  const keyDir = join(cache, keyId(key));
  assert.equal(pruneCache(cache, { now }).length, 1);
  assert.equal(existsSync(old), false);
  assert.deepEqual(readdirSync(keyDir), []);
  storeTemplate(cache, key, made, record, { now: now - 25 * HOUR });
  const stuck = readdirSync(keyDir)[0];
  mkdirSync(join(keyDir, stuck, "template", "locked-dir"), { recursive: true });
  writeFileSync(join(keyDir, stuck, "template", "locked-dir", "f"), "x");
  if (process.getuid?.() !== 0) {
    chmodSync(join(keyDir, stuck, "template", "locked-dir"), 0o500);
    try {
      pruneCache(cache, { now });
      assert.equal(lookupTemplate(cache, key, { now: now - 25 * HOUR + 1000 }).hit, false);
      assert.ok(readdirSync(keyDir).every((n) => n.startsWith(".deleting-")));
    } finally {
      for (const n of readdirSync(keyDir)) try { chmodSync(join(keyDir, n, "template", "locked-dir"), 0o700); } catch {}
    }
    pruneCache(cache, { now });
    assert.deepEqual(readdirSync(keyDir), []);
  }
}));
