import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { componentsState, sidesProblems, STARTUP_COMPONENTS, templateProblems, templateSizes, waitForStartupComponents } from "./template-state.mjs";
import { UBO_ID, uboSettled, uboSignature } from "./ubo-cache.mjs";

const withData = (fn) => async () => {
  const data = mkdtempSync(join(tmpdir(), "bench-template-"));
  try {
    await fn(data);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
};

const install = (data, folder, version) => {
  mkdirSync(join(data, "Chromium", folder, version), { recursive: true });
  writeFileSync(join(data, "Chromium", folder, version, "manifest.json"), "{}");
};

const MB = 1048576;
const good = { sizes: { uboStoreMB: 34.6, uboBlobsMB: 21.2, uboLogMB: 0.004 }, components: { CertificateRevocation: { version: "10918", checked: true } } };

test("components settle only when each is installed: the updater's answer alone, written before its downloads, doesn't count", withData((data) => {
  mkdirSync(join(data, "Chromium", "CertificateRevocation"), { recursive: true });
  assert.equal(componentsState(data).settled, false);
  install(data, "CertificateRevocation", "10918");
  install(data, "PKIMetadata", "1839");
  const ssl = Object.keys(STARTUP_COMPONENTS).find((id) => STARTUP_COMPONENTS[id] === "SSLErrorAssistant");
  writeFileSync(join(data, "Chromium", "Local State"), JSON.stringify({ updateclientdata: { apps: { [ssl]: { dlrc: 7263, pv: "0" } } } }));
  const answered = componentsState(data);
  assert.equal(answered.settled, false);
  assert.deepEqual(answered.components.SSLErrorAssistant, { version: null, checked: true });
  mkdirSync(join(data, "Chromium", "SSLErrorAssistant", "7"), { recursive: true });
  assert.equal(componentsState(data).settled, false);
  install(data, "SSLErrorAssistant", "7");
  assert.equal(componentsState(data).settled, true);
}));

test("waiting for components fails at its deadline instead of saving a template without them", withData(async (data) => {
  await assert.rejects(waitForStartupComponents({ dataDir: data, launchedAt: Date.now(), deadlineMs: 50, pollMs: 10 }), /installed every startup component/);
}));

test("a template saved mid-write is refused, a settled one passes", () => {
  assert.deepEqual(templateProblems(good), []);
  const midWrite = { sizes: { uboStoreMB: 66.0, uboBlobsMB: 7.8, uboLogMB: 3.4 }, components: good.components };
  assert.equal(templateProblems(midWrite).length, 3);
  assert.match(templateProblems({ ...good, components: { PKIMetadata: { version: null, checked: true } } })[0], /PKIMetadata isn't installed/);
});

test("two sides whose uBO stores differ by more than a fifth are refused", () => {
  assert.deepEqual(sidesProblems([good, { ...good, sizes: { ...good.sizes, uboStoreMB: 36 } }]), []);
  assert.equal(sidesProblems([good, { ...good, sizes: { ...good.sizes, uboStoreMB: 66 } }]).length, 1);
});

test("uBO's store counts as settled only once its LevelDB log is flushed, and its signature sees blob writes", withData((data) => {
  const store = join(data, "Chromium", "Default", "Local Extension Settings", UBO_ID);
  const blobs = join(data, "Chromium", "Default", "IndexedDB", `chrome-extension_${UBO_ID}_0.indexeddb.blob`, "1", "00");
  mkdirSync(store, { recursive: true });
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(store, "000012.log"), Buffer.alloc(2 * MB));
  writeFileSync(join(store, "000013.ldb"), Buffer.alloc(MB));
  assert.equal(uboSettled(data), false);
  writeFileSync(join(store, "000012.log"), Buffer.alloc(4096));
  assert.equal(uboSettled(data), true);
  const before = uboSignature(data);
  writeFileSync(join(blobs, "1"), Buffer.alloc(MB));
  assert.notEqual(uboSignature(data), before);
  const sizes = templateSizes(data);
  assert.equal(Math.round(sizes.uboBlobsMB), 1);
  assert.ok(sizes.uboStoreMB > 1 && sizes.uboStoreMB < 1.01);
}));
