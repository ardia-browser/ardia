import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./asc.mjs", import.meta.url));

function fakeAppStoreConnect() {
  const groups = JSON.parse(process.env.ASC_FAKE_GROUPS);
  const reply = (data, status = 200) => new Response(data === null ? null : JSON.stringify({ data }), { status });
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    appendFileSync(process.env.ASC_FAKE_LOG, `${JSON.stringify({ method, path, body })}\n`);
    if (path === "/v1/apps") return reply([{ id: "app", attributes: { bundleId: "com.ardia.browser.ios", name: "Ardia" } }]);
    if (path === "/v1/builds") return reply([{ id: "build", attributes: { version: "7", processingState: "VALID" } }]);
    if (path === "/v1/apps/app/betaGroups") return reply(groups);
    if (method === "POST" && path === "/v1/betaGroups") {
      groups.push({ id: "made", type: "betaGroups", attributes: { ...body.data.attributes, isInternalGroup: false, iosBuildsAvailableForAppleSiliconMac: true } });
      return reply(groups.at(-1), 201);
    }
    const group = groups.find((row) => path === `/v1/betaGroups/${row.id}`);
    if (group && method === "PATCH") Object.assign(group.attributes, body.data.attributes);
    if (group) return reply(group);
    if (path.endsWith("/relationships/builds")) return reply(null, 204);
    if (path === "/v1/betaAppReviewSubmissions") return reply({ id: "submission" }, 201);
    return reply(null, 404);
  };
}

function publicLink(groups) {
  const dir = mkdtempSync(join(tmpdir(), "asc-"));
  const key = join(dir, "AuthKey.p8");
  writeFileSync(key, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const preload = `import { appendFileSync } from "node:fs";\n(${fakeAppStoreConnect})();`;
  execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, script, "public-link", "--build", "7"], {
    env: { ...process.env, ASC_KEY: key, ASC_KEY_ID: "key", ASC_ISSUER: "issuer", ASC_FAKE_GROUPS: JSON.stringify(groups), ASC_FAKE_LOG: log },
  });
  const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return requests.filter((request) => request.method === "PATCH" && request.path.startsWith("/v1/betaGroups/"));
}

const turnsMacOff = (id) => ({
  method: "PATCH",
  path: `/v1/betaGroups/${id}`,
  body: { data: { type: "betaGroups", id, attributes: { iosBuildsAvailableForAppleSiliconMac: false } } },
});

test("public-link keeps the Public Testers group's builds off Apple silicon Macs", () => {
  const group = (mac) => ({ id: "public", type: "betaGroups", attributes: { name: "Public Testers", isInternalGroup: false, iosBuildsAvailableForAppleSiliconMac: mac } });
  assert.deepEqual(publicLink([]), [turnsMacOff("made")]);
  assert.deepEqual(publicLink([group(true)]), [turnsMacOff("public")]);
  assert.deepEqual(publicLink([group(false)]), []);
});

function registerDevice(known) {
  const dir = mkdtempSync(join(tmpdir(), "asc-"));
  const key = join(dir, "AuthKey.p8");
  writeFileSync(key, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const fake = () => {
    const devices = JSON.parse(process.env.ASC_FAKE_DEVICES);
    globalThis.fetch = async (url, init = {}) => {
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(init.body) : undefined;
      appendFileSync(process.env.ASC_FAKE_LOG, `${JSON.stringify({ method, path: new URL(url).pathname, udid: new URL(url).searchParams.get("filter[udid]"), body })}\n`);
      if (new URL(url).pathname !== "/v1/devices") return new Response(null, { status: 404 });
      if (method === "POST") return new Response(JSON.stringify({ data: { id: "new", attributes: body.data.attributes } }), { status: 201 });
      return new Response(JSON.stringify({ data: devices }), { status: 200 });
    };
  };
  const preload = `import { appendFileSync } from "node:fs";\n(${fake})();`;
  const said = execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, script, "register-device", "--udid", "00008140-000A1B2C3D4E5F60"], {
    env: { ...process.env, ASC_KEY: key, ASC_KEY_ID: "key", ASC_ISSUER: "issuer", ASC_FAKE_DEVICES: JSON.stringify(known), ASC_FAKE_LOG: log },
    encoding: "utf8",
  });
  const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { said, posts: requests.filter((request) => request.method === "POST"), asked: requests[0] };
}

test("register-device adds an iPhone the team doesn't have, leaves one it has, and never prints the UDID", () => {
  const fresh = registerDevice([]);
  assert.equal(fresh.asked.udid, "00008140-000A1B2C3D4E5F60");
  assert.deepEqual(fresh.posts.map((post) => post.body), [{ data: { type: "devices", attributes: { name: "iPhone", udid: "00008140-000A1B2C3D4E5F60", platform: "IOS" } } }]);
  const there = registerDevice([{ id: "d", type: "devices", attributes: { udid: "00008140-000A1B2C3D4E5F60", status: "ENABLED" } }]);
  assert.deepEqual(there.posts, []);
  for (const run of [fresh, there]) assert.doesNotMatch(run.said, /00008140/);
});

function nextBuild(failures, status = 500, failing = "/v1/apps") {
  const dir = mkdtempSync(join(tmpdir(), "asc-"));
  const key = join(dir, "AuthKey.p8");
  writeFileSync(key, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const fake = () => {
    let left = Number(process.env.ASC_FAKE_FAILURES);
    const status = Number(process.env.ASC_FAKE_STATUS);
    const failing = process.env.ASC_FAKE_FAILING;
    globalThis.setTimeout = (resume) => queueMicrotask(resume);
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      appendFileSync(process.env.ASC_FAKE_LOG, `${path}\n`);
      if (path === failing && left-- > 0) return new Response(JSON.stringify({ errors: [{ detail: "An unexpected error occurred on the server side." }] }), { status });
      if (path === "/v1/apps") return new Response(JSON.stringify({ data: [{ id: "app", attributes: { bundleId: "com.ardia.browser.ios", name: "Ardia" } }] }), { status: 200 });
      if (path === "/v1/builds") return new Response(JSON.stringify({ data: [{ id: "build", attributes: { version: "9" } }] }), { status: 200 });
      if (path === "/v1/apps/app/buildUploads") return new Response(JSON.stringify({ data: [{ id: "upload", attributes: { cfBundleVersion: "11" } }] }), { status: 200 });
      return new Response(null, { status: 404 });
    };
  };
  const preload = `import { appendFileSync } from "node:fs";\n(${fake})();`;
  const run = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, script, "next-build"], {
    env: { ...process.env, ASC_KEY: key, ASC_KEY_ID: "key", ASC_ISSUER: "issuer", ASC_FAKE_FAILURES: String(failures), ASC_FAKE_STATUS: String(status), ASC_FAKE_FAILING: failing, ASC_FAKE_LOG: log },
    encoding: "utf8",
  });
  const asked = readFileSync(log, "utf8").trim().split("\n").filter((path) => path === failing).length;
  return { code: run.status, said: run.stdout.trim(), warned: run.stderr, asked };
}

test("a read Apple answers with a server error is asked again, and next-build still gives the number after the highest upload", () => {
  assert.deepEqual({ ...nextBuild(0), warned: "" }, { code: 0, said: "12", warned: "", asked: 1 });
  const twice = nextBuild(2);
  assert.deepEqual([twice.code, twice.said, twice.asked], [0, "12", 3]);
  assert.match(twice.warned, /answered 500, asking again/);
  assert.deepEqual([nextBuild(1, 429).code, nextBuild(1, 429).said], [0, "12"]);
});

test("a server error that lasts stops after four tries with Apple's words, and a refusal isn't asked again", () => {
  const down = nextBuild(9);
  assert.notEqual(down.code, 0);
  assert.equal(down.asked, 4);
  assert.match(down.warned, /500 An unexpected error occurred on the server side/);
  const refused = nextBuild(9, 403);
  assert.notEqual(refused.code, 0);
  assert.equal(refused.asked, 1);
});

test("a write Apple answers with a server error is never sent twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "asc-"));
  const key = join(dir, "AuthKey.p8");
  writeFileSync(key, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const fake = () => {
    globalThis.fetch = async (url, init = {}) => {
      appendFileSync(process.env.ASC_FAKE_LOG, `${init.method ?? "GET"}\n`);
      if (init.method === "POST") return new Response(JSON.stringify({ errors: [{ detail: "An unexpected error occurred on the server side." }] }), { status: 500 });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
  };
  const preload = `import { appendFileSync } from "node:fs";\n(${fake})();`;
  const run = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, script, "register-device", "--udid", "00008140-000A1B2C3D4E5F60"], {
    env: { ...process.env, ASC_KEY: key, ASC_KEY_ID: "key", ASC_ISSUER: "issuer", ASC_FAKE_LOG: log },
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["GET", "POST"]);
});

test("next-build gives no number when the uploads can't be read, and counts the builds alone only when Apple refuses the list", () => {
  const down = nextBuild(9, 500, "/v1/apps/app/buildUploads");
  assert.notEqual(down.code, 0);
  assert.deepEqual([down.said, down.asked], ["", 4]);
  const refused = nextBuild(9, 403, "/v1/apps/app/buildUploads");
  assert.deepEqual([refused.code, refused.said, refused.asked], [0, "10", 1]);
});
