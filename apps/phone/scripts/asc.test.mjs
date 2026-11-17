import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
