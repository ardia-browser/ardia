import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

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

function fakeAppStore() {
  const state = JSON.parse(process.env.ASC_FAKE_STATE);
  const log = (entry) => appendFileSync(process.env.ASC_FAKE_LOG, `${JSON.stringify(entry)}\n`);
  let made = 0;
  let submissionReads = 0;
  let versionReads = 0;
  const tokens = new Set();
  if (state.clock) {
    let now = Date.now();
    Date.now = () => now;
    globalThis.setTimeout = (resume, ms) => {
      now += ms ?? 0;
      queueMicrotask(resume);
    };
  } else {
    globalThis.setTimeout = (resume) => queueMicrotask(resume);
  }
  const reply = (data, status = 200, included) => new Response(data === undefined ? null : JSON.stringify({ data, included }), { status });
  const versionRow = (version) => ({
    id: version.id,
    type: "appStoreVersions",
    attributes: { versionString: version.version, appVersionState: version.state, releaseType: version.releaseType ?? "MANUAL", copyright: "copyright" in version ? version.copyright : "2026 Example", createdDate: version.created ?? null },
    relationships: { build: { data: version.build ? { type: "builds", id: version.build } : null } },
  });
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const { pathname: path, searchParams } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const claims = JSON.parse(Buffer.from(String(init.headers?.Authorization ?? "").split(".")[1] ?? "", "base64url").toString() || "{}");
    if (!tokens.has(claims.iat)) {
      tokens.add(claims.iat);
      log({ method: "TOKEN", iat: claims.iat, exp: claims.exp });
    }
    if (state.clock && !(claims.exp > Date.now() / 1000)) return new Response(JSON.stringify({ errors: [{ detail: "The token is expired." }] }), { status: 401 });
    if (method !== "GET") log({ method, path, body });
    if ((state.forbid ?? []).includes(`${method} ${path}`)) return new Response(JSON.stringify({ errors: [{ detail: "The API key in use does not allow this request" }] }), { status: 403 });
    const id = () => `made-${++made}`;
    if (path === "/v1/apps") return reply([{ id: "app", attributes: { bundleId: "com.ardia.browser.ios", name: "Ardia", primaryLocale: "en-US" } }]);
    if (path === "/v1/builds") {
      if (state.buildFailures > 0) {
        state.buildFailures--;
        return new Response(JSON.stringify({ errors: [{ detail: "Service Unavailable" }] }), { status: 503 });
      }
      const rows = state.builds.filter((build) => build.number === searchParams.get("filter[version]"));
      return reply(
        rows.map((build) => ({
          id: build.id,
          type: "builds",
          attributes: { version: build.number, processingState: build.processing.shift() ?? "VALID", expired: build.expired ?? false, usesNonExemptEncryption: "encryption" in build ? build.encryption : false },
          relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: `pre-${build.id}` } } },
        })),
        200,
        rows.map((build) => ({ id: `pre-${build.id}`, type: "preReleaseVersions", attributes: { version: build.version } })),
      );
    }
    if (path === "/v1/apps/app/appStoreVersions") {
      versionReads++;
      if (state.submittedOnce && state.afterSubmit === "fail") return new Response(JSON.stringify({ errors: [{ detail: "The API key in use does not allow this request" }] }), { status: 403 });
      if (state.submittedOnce && state.afterSubmit === "network") throw new TypeError("fetch failed");
      if (state.submittedOnce && state.afterSubmit === "garbage") return new Response("<html>bad gateway</html>", { status: 200, headers: { "content-type": "application/json" } });
      if (state.submittedOnce && state.afterSubmit === "hide") return reply(state.versions.filter((row) => row.id !== "v101").map(versionRow), 200, []);
      if (state.mutate && versionReads === state.mutate.after + 1) Object.assign(state.versions.find((row) => row.id === state.mutate.id), state.mutate.changes);
      return reply(state.versions.map(versionRow), 200, state.builds.map((build) => ({ id: build.id, type: "builds", attributes: { version: build.number } })));
    }
    if (method === "POST" && path === "/v1/appStoreVersions") {
      const version = { id: id(), version: body.data.attributes.versionString, state: "PREPARE_FOR_SUBMISSION", releaseType: body.data.attributes.releaseType, copyright: body.data.attributes.copyright ?? state.copyrightOnCreate ?? null };
      state.versions.push(version);
      return reply(versionRow(version), 201);
    }
    const declarationMatch = path.match(/^\/v1\/builds\/([^/]+)\/appEncryptionDeclaration$/);
    if (declarationMatch) {
      const declared = state.builds.find((row) => row.id === declarationMatch[1])?.declaration;
      return reply(declared ? { id: "declaration", type: "appEncryptionDeclarations", attributes: { appEncryptionDeclarationState: declared } } : null);
    }
    const versionMatch = path.match(/^\/v1\/appStoreVersions\/([^/]+)(.*)$/);
    const version = versionMatch && state.versions.find((row) => row.id === versionMatch[1]);
    if (version && versionMatch[2] === "/relationships/build") {
      version.build = body.data.id;
      if (state.transitions?.attach) version.state = state.transitions.attach;
      return reply(undefined, 204);
    }
    if (version && versionMatch[2] === "" && method === "PATCH") {
      if (body.data.attributes.versionString) version.version = body.data.attributes.versionString;
      if (body.data.attributes.releaseType) version.releaseType = body.data.attributes.releaseType;
      return reply(versionRow(version));
    }
    if (version && versionMatch[2] === "/appStoreVersionLocalizations") {
      return reply((state.localizations[version.id] ?? []).map((row) => ({ id: row.id, type: "appStoreVersionLocalizations", attributes: row })));
    }
    if (version && versionMatch[2] === "/appStoreReviewDetail") return reply(state.review ? { id: "review", type: "appStoreReviewDetails", attributes: state.review } : null);
    if (path.startsWith("/v1/appStoreVersionLocalizations/") && path.endsWith("/appScreenshotSets")) {
      const asSet = (set) => (typeof set === "object" && !Array.isArray(set) ? set : { type: "APP_IPHONE_67", shots: set });
      const types = state.screenshots.map((set) => asSet(set).type);
      const shots = state.screenshots.map((set) => {
        const listed = asSet(set).shots;
        return Array.isArray(listed) ? listed : Array(listed).fill("COMPLETE");
      });
      const sets = shots.map((states, at) => ({
        id: `set-${at}`,
        type: "appScreenshotSets",
        attributes: { screenshotDisplayType: types[at] },
        relationships: { appScreenshots: { data: states.map((_, shot) => ({ type: "appScreenshots", id: `shot-${at}-${shot}` })) } },
      }));
      const included = shots.flatMap((states, at) => states.map((delivery, shot) => ({ id: `shot-${at}-${shot}`, type: "appScreenshots", attributes: { assetDeliveryState: { state: delivery } } })));
      return reply(sets, 200, included);
    }
    if (method === "POST" && path === "/v1/appStoreVersionLocalizations") return reply({ id: id(), type: "appStoreVersionLocalizations", attributes: body.data.attributes }, 201);
    if (method === "PATCH" && path.startsWith("/v1/appStoreVersionLocalizations/")) return reply({ id: path.split("/").at(-1), attributes: body.data.attributes });
    if (path === "/v1/reviewSubmissions" && method === "GET") {
      submissionReads++;
      if (state.race && submissionReads === state.race.after + 1) state.submissions.push(state.race.submission);
      return reply(state.submissions.map((row) => ({ id: row.id, type: "reviewSubmissions", attributes: { state: row.state, platform: "IOS", submittedDate: row.submitted ?? null } })));
    }
    if (path === "/v1/reviewSubmissions" && method === "POST") {
      state.submissions.push({ id: id(), state: "READY_FOR_REVIEW", items: [] });
      return reply({ id: state.submissions.at(-1).id, type: "reviewSubmissions", attributes: { state: "READY_FOR_REVIEW" } }, 201);
    }
    const submissionMatch = path.match(/^\/v1\/reviewSubmissions\/([^/]+)(.*)$/);
    const submission = submissionMatch && state.submissions.find((row) => row.id === submissionMatch[1]);
    if (submission && submissionMatch[2] === "/items") {
      return reply(
        submission.items.map((item, at) => ({
          id: `item-${submission.id}-${at}`,
          type: "reviewSubmissionItems",
          attributes: { state: submission.itemStates?.[item] ?? "READY_FOR_REVIEW" },
          relationships: { appStoreVersion: { data: item.startsWith("event:") ? null : { type: "appStoreVersions", id: item } } },
        })),
      );
    }
    if (submission && method === "PATCH" && body.data.attributes.submitted) {
      state.submittedOnce = true;
      if (state.swapBuildOnSubmit) state.versions.find((row) => submission.items.includes(row.id)).build = state.swapBuildOnSubmit;
      if (state.swapReleaseOnSubmit) state.versions.find((row) => submission.items.includes(row.id)).releaseType = state.swapReleaseOnSubmit;
    }
    if (submission && method === "PATCH") return reply({ id: submission.id, type: "reviewSubmissions", attributes: { state: "WAITING_FOR_REVIEW" } });
    if (method === "PATCH" && path.startsWith("/v1/reviewSubmissionItems/")) {
      const resolved = state.submissions.find((row) => path.includes(`item-${row.id}-`));
      const resolvedVersion = state.versions.find((row) => resolved?.items.includes(row.id));
      if (state.transitions?.resolve && resolvedVersion) resolvedVersion.state = state.transitions.resolve;
      if (state.raceAfterResolve) state.submissions.find((row) => row.items.length > 0 && path.includes(`item-${row.id}-`)).items.push(state.raceAfterResolve);
    }
    if (method === "PATCH" && path.startsWith("/v1/reviewSubmissionItems/")) return reply({ id: path.split("/").at(-1), type: "reviewSubmissionItems", attributes: { state: "READY_FOR_REVIEW" } });
    if (method === "POST" && path === "/v1/reviewSubmissionItems") {
      const target = state.submissions.find((row) => row.id === body.data.relationships.reviewSubmission.data.id);
      target.items.push(body.data.relationships.appStoreVersion.data.id);
      const added = state.versions.find((row) => row.id === body.data.relationships.appStoreVersion.data.id);
      if (state.transitions?.addItem && added) added.state = state.transitions.addItem;
      if (state.raceItem) target.items.push(state.raceItem);
      return reply({ id: id(), type: "reviewSubmissionItems" }, 201);
    }
    return reply(null, 404);
  };
}

const reviewReady = { contactFirstName: "A", contactLastName: "B", contactPhone: "+1 555 0100", contactEmail: "review@example.com", notes: "Continue with ChatGPT: sign in with the demo plan.", demoAccountRequired: false };
const listing = { locale: "en-US", description: "A browser.", keywords: "browser", supportUrl: "https://example.com/support" };

function appStoreState(changes = {}) {
  return {
    builds: [
      { id: "b12", number: "12", version: "1.0.1", processing: [] },
      { id: "b9", number: "9", version: "1.0.0", processing: [] },
    ],
    versions: [],
    localizations: {},
    review: reviewReady,
    screenshots: [3, { type: "APP_IPAD_PRO_3GEN_129", shots: 3 }],
    submissions: [],
    ...changes,
  };
}

function appStore(state, extra = [], iosDir) {
  const dir = mkdtempSync(join(tmpdir(), "asc-"));
  const key = join(dir, "AuthKey.p8");
  writeFileSync(key, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const preload = `import { appendFileSync } from "node:fs";\n(${fakeAppStore})();`;
  const args = ["app-store", ...(extra.includes("--build") ? [] : ["--build", "12"]), ...extra, "--ios-dir", iosDir ?? fakeIosDir("1")];
  const run = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, script, ...args], {
    env: { ...process.env, ASC_KEY: key, ASC_KEY_ID: "key", ASC_ISSUER: "issuer", ASC_FAKE_STATE: JSON.stringify(state), ASC_FAKE_LOG: log },
    encoding: "utf8",
  });
  const entries = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const writes = entries.filter((entry) => entry.method !== "TOKEN");
  const tokens = entries.filter((entry) => entry.method === "TOKEN");
  return { code: run.status, out: run.stdout, err: run.stderr, writes, tokens, steps: writes.map((write) => `${write.method} ${write.path}`) };
}

const shippedBefore = { id: "v100", version: "1.0.0", state: "READY_FOR_SALE", build: "b9", copyright: "2026 Example" };

test("app-store makes the version, attaches the build, keeps the release manual and submits it", () => {
  const run = appStore(appStoreState({ versions: [shippedBefore], localizations: { "made-1": [{ id: "loc", ...listing }] } }));
  assert.equal(run.code, 0, run.err);
  assert.deepEqual(run.steps, [
    "POST /v1/appStoreVersions",
    "PATCH /v1/appStoreVersions/made-1/relationships/build",
    "PATCH /v1/appStoreVersionLocalizations/loc",
    "POST /v1/reviewSubmissions",
    "POST /v1/reviewSubmissionItems",
    "PATCH /v1/reviewSubmissions/made-2",
  ]);
  assert.deepEqual(run.writes[0].body.data.attributes, { platform: "IOS", versionString: "1.0.1", releaseType: "MANUAL", copyright: "2026 Example" });
  assert.match(run.out, /copyright carried from the last version/);
  assert.deepEqual(run.writes[1].body, { data: { type: "builds", id: "b12" } });
  assert.equal(run.writes[2].body.data.attributes.whatsNew, "Bug fixes and improvements.");
  assert.match(run.out, /no --notes given/);
  assert.deepEqual(run.writes[5].body.data.attributes, { submitted: true });
  assert.match(run.out, /press Release in App Store Connect/);
});

test("app-store takes What's New from the notes file, and leaves it out on the app's first version", () => {
  const notes = join(mkdtempSync(join(tmpdir(), "asc-notes-")), "notes.txt");
  writeFileSync(notes, "  Faster tabs.\n");
  const second = appStore(appStoreState({ versions: [shippedBefore], localizations: { "made-1": [{ id: "loc", ...listing }] } }), ["--notes", notes]);
  assert.equal(second.code, 0, second.err);
  assert.equal(second.writes.find((write) => write.path === "/v1/appStoreVersionLocalizations/loc").body.data.attributes.whatsNew, "Faster tabs.");
  assert.doesNotMatch(second.out, /no --notes given/);
  const first = appStore(appStoreState({ versions: [{ id: "v101", version: "1.0.1", state: "PREPARE_FOR_SUBMISSION" }], localizations: { v101: [{ id: "loc", ...listing }] } }), ["--notes", notes]);
  assert.equal(first.code, 0, first.err);
  assert.ok(!first.steps.some((step) => step.includes("Localizations")));
  assert.match(first.out, /What's New left out/);
  writeFileSync(notes, "x".repeat(4001));
  const long = appStore(appStoreState(), ["--notes", notes]);
  assert.equal(long.code, 1);
  assert.match(long.err, /at most 4000/);
  assert.deepEqual(long.writes, []);
});

test("app-store re-run reports an attached build and an open submission instead of adding them again", () => {
  const draft = { id: "v101", version: "1.0.1", state: "PREPARE_FOR_SUBMISSION", build: "b12", releaseType: "AFTER_APPROVAL" };
  const run = appStore(
    appStoreState({ versions: [shippedBefore, draft], localizations: { v101: [{ id: "loc", ...listing, whatsNew: "Bug fixes and improvements." }] }, submissions: [{ id: "s1", state: "READY_FOR_REVIEW", items: ["v101"] }] }),
  );
  assert.equal(run.code, 0, run.err);
  assert.deepEqual(run.steps, ["PATCH /v1/appStoreVersions/v101", "PATCH /v1/reviewSubmissions/s1"]);
  assert.deepEqual(run.writes[0].body.data.attributes, { releaseType: "MANUAL" });
  assert.match(run.out, /build 12 is already attached/);
  assert.match(run.out, /already reads the notes/);
  assert.match(run.out, /version 1\.0\.1 is already in it/);
});

test("app-store does nothing for a version already waiting for review with this build", () => {
  for (const state of ["WAITING_FOR_REVIEW", "IN_REVIEW", "PENDING_DEVELOPER_RELEASE"]) {
    const run = appStore(appStoreState({ versions: [{ id: "v101", version: "1.0.1", state, build: "b12" }] }));
    assert.equal(run.code, 0, run.err);
    assert.deepEqual(run.writes, []);
    assert.match(run.out, new RegExp(`already ${state}; nothing to do`));
  }
  const submitted = appStore(
    appStoreState({ versions: [{ id: "v101", version: "1.0.1", state: "PREPARE_FOR_SUBMISSION", build: "b12" }], localizations: { v101: [{ id: "loc", ...listing }] }, submissions: [{ id: "s1", state: "WAITING_FOR_REVIEW", items: ["v101"] }] }),
  );
  assert.equal(submitted.code, 0, submitted.err);
  assert.ok(!submitted.steps.some((step) => step.includes("reviewSubmission")));
  assert.match(submitted.out, /already in a review submission that is WAITING_FOR_REVIEW/);
});

test("app-store refuses another version in review, a released version, another build in review and a busy submission", () => {
  const cases = [
    [{ versions: [{ id: "v100", version: "1.0.0", state: "WAITING_FOR_REVIEW", build: "b9" }] }, /version 1\.0\.0 is WAITING_FOR_REVIEW/],
    [{ versions: [{ id: "v100", version: "1.0.0", state: "PENDING_DEVELOPER_RELEASE", build: "b9" }] }, /version 1\.0\.0 is PENDING_DEVELOPER_RELEASE/],
    [{ versions: [{ id: "v101", version: "1.0.1", state: "READY_FOR_SALE", build: "b9" }] }, /already READY_FOR_SALE; a new App Store release needs a new version/],
    [{ versions: [{ id: "v101", version: "1.0.1", state: "IN_REVIEW", build: "b9" }] }, /IN_REVIEW with build 9/],
    [
      { versions: [{ id: "v101", version: "1.0.1", state: "PREPARE_FOR_SUBMISSION", build: "b12" }], localizations: { v101: [{ id: "loc", ...listing }] }, submissions: [{ id: "s1", state: "IN_REVIEW", items: ["other"] }] },
      /review submission s1 is IN_REVIEW and holds version other; wait for it or cancel it/,
    ],
    [{ builds: [{ id: "b12", number: "12", version: "1.0.1", processing: ["INVALID"] }] }, /build 12 of 1\.0\.1 is INVALID/],
    [{ builds: [{ id: "b12", number: "12", version: "1.0.1", processing: [], expired: true }] }, /build 12 of 1\.0\.1 has expired/],
    [{ builds: [{ id: "b12", number: "12", version: "1.0.1", processing: [], encryption: null }] }, /no export compliance answer/],
    [{ builds: [] }, /build 12 of 1\.0\.1 is not on App Store Connect/],
  ];
  for (const [changes, refusal] of cases) {
    const run = appStore(appStoreState(changes));
    assert.equal(run.code, 1, `${refusal}: ${run.out}`);
    assert.match(run.err, refusal);
    assert.ok(!run.steps.some((step) => step.startsWith("PATCH /v1/reviewSubmissions")), `${refusal} submitted`);
  }
  const mismatch = appStore(appStoreState(), ["--version", "1.1.0"]);
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.err, /--version 1\.1\.0 isn't the pinned iPhone version 1\.0\.1/);
  assert.deepEqual(mismatch.writes, []);
  const bumped = appStore(
    appStoreState({ builds: [{ id: "b12", number: "12", version: "1.1.0", processing: [] }], versions: [shippedBefore], localizations: { "made-1": [{ id: "loc", ...listing }] } }),
    [],
    fakeIosDir("1", "1.1.0"),
  );
  assert.equal(bumped.code, 0, bumped.err);
  assert.equal(bumped.writes[0].body.data.attributes.versionString, "1.1.0");
});

test("app-store renames a draft of another version instead of making a second one, and replaces its build", () => {
  const run = appStore(appStoreState({ versions: [shippedBefore, { id: "v102", version: "1.0.2", state: "PREPARE_FOR_SUBMISSION", build: "b9" }], localizations: { v102: [{ id: "loc", ...listing }] } }));
  assert.equal(run.code, 0, run.err);
  assert.deepEqual(run.writes[0], { method: "PATCH", path: "/v1/appStoreVersions/v102", body: { data: { type: "appStoreVersions", id: "v102", attributes: { versionString: "1.0.1" } } } });
  assert.ok(!run.steps.includes("POST /v1/appStoreVersions"));
  assert.match(run.out, /build 12 attached in place of build 9/);
});

test("app-store waits for a build still processing when given a timeout, and refuses it without one", () => {
  const processing = { builds: [{ id: "b12", number: "12", version: "1.0.1", processing: ["PROCESSING", "PROCESSING"] }], versions: [shippedBefore], localizations: { "made-1": [{ id: "loc", ...listing }] } };
  const waited = appStore(appStoreState(processing), ["--timeout", "600"]);
  assert.equal(waited.code, 0, waited.err);
  assert.match(waited.out, /build 12 of 1\.0\.1: PROCESSING, waiting/);
  const now = appStore(appStoreState(processing));
  assert.equal(now.code, 1);
  assert.match(now.err, /build 12 of 1\.0\.1 is PROCESSING/);
});

test("app-store lists what App Review still needs and submits nothing", () => {
  const run = appStore(
    appStoreState({
      versions: [shippedBefore],
      localizations: { "made-1": [{ id: "loc", locale: "en-US", description: "A browser." }] },
      review: { contactEmail: "review@example.com", notes: "Sign in with the demo account.", demoAccountRequired: true },
      screenshots: [],
    }),
  );
  assert.equal(run.code, 1);
  for (const gap of ["en-US keywords", "en-US support URL", "en-US iPhone screenshots in APP_IPHONE_61 or APP_IPHONE_67", "App Review contact first name", "App Review contact phone", "demo account name and password"]) {
    assert.match(run.err, new RegExp(`- [^\\n]*${gap}`));
  }
  assert.doesNotMatch(run.err, /contact email|ChatGPT|iPad/);
  assert.ok(!run.steps.some((step) => step.includes("reviewSubmission")));
  const none = appStore(appStoreState({ versions: [shippedBefore], localizations: { "made-1": [{ id: "loc", ...listing }] }, review: null }));
  assert.equal(none.code, 1);
  assert.match(none.err, /App Review Information: contact name, phone, email and notes/);
});

test("preflight refuses a missing export compliance answer, privacy manifest or default browser entitlement before any request", () => {
  const ios = mkdtempSync(join(tmpdir(), "asc-ios-"));
  mkdirSync(join(ios, "Ardia"));
  mkdirSync(join(ios, "Config"));
  const plist = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
  writeFileSync(join(ios, "Ardia", "Info.plist"), plist("\t<key>CFBundleVersion</key>\n\t<string>1</string>"));
  writeFileSync(join(ios, "Config", "Ardia-DefaultBrowser.entitlements"), plist(""));
  const bare = appStore(appStoreState(), [], ios);
  assert.equal(bare.code, 1);
  assert.match(bare.err, /ITSAppUsesNonExemptEncryption/);
  assert.match(bare.err, /PrivacyInfo\.xcprivacy is missing/);
  assert.match(bare.err, /com\.apple\.developer\.web-browser/);
  assert.match(bare.err, /TARGETED_DEVICE_FAMILY/);
  assert.match(bare.err, /release-version must hold one line with the version as x\.y\.z/);
  assert.match(bare.err, /first-iphone-only-build must hold one line with a build number/);
  assert.deepEqual(bare.writes, []);
  assert.deepEqual(bare.tokens, [], "no request, not even a read, before preflight refuses");
  writeFileSync(join(ios, "Ardia", "Info.plist"), plist("\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>"));
  writeFileSync(join(ios, "PrivacyInfo.xcprivacy"), plist(""));
  mkdirSync(join(ios, "Ardia.xcodeproj"));
  writeFileSync(join(ios, "Ardia.xcodeproj", "project.pbxproj"), readFileSync(join(fakeIosDir('"1,2"'), "Ardia.xcodeproj", "project.pbxproj")));
  writeFileSync(join(ios, "Config", "release-version"), "1.0.1\n");
  writeFileSync(join(ios, "Config", "first-iphone-only-build"), "1\n");
  const unsigned = spawnSync(process.execPath, [script, "preflight", "--no-default-browser", "--ios-dir", ios], { encoding: "utf8", env: { ...process.env, ASC_KEY: "", ASC_KEY_ID: "", ASC_ISSUER: "" } });
  assert.equal(unsigned.status, 0, unsigned.stderr);
  assert.match(unsigned.stdout, /preflight passed: [^\n]*version 1\.0\.1 from build 1, for iPhone and iPad/);
  const signed = spawnSync(process.execPath, [script, "preflight", "--ios-dir", ios], { encoding: "utf8" });
  assert.equal(signed.status, 1);
  assert.match(signed.stderr, /--no-default-browser/);
  const repo = spawnSync(process.execPath, [script, "preflight"], { encoding: "utf8" });
  assert.equal(repo.status, 0, repo.stderr);
  const pinned = readFileSync(fileURLToPath(new URL("../ios/Config/release-version", import.meta.url)), "utf8").trim();
  assert.match(repo.stdout, new RegExp(`version ${pinned.replaceAll(".", "\\.")} from build \\d+, for iPhone\n`));
});

test("status lists the App Store versions with their state and the newest review submission first", () => {
  const dir = mkdtempSync(join(tmpdir(), "asc-"));
  const key = join(dir, "AuthKey.p8");
  writeFileSync(key, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const state = appStoreState({
    versions: [shippedBefore, { id: "v101", version: "1.0.1", state: "WAITING_FOR_REVIEW", build: "b12" }],
    submissions: [
      { id: "s0", state: "COMPLETE", submitted: "2026-10-01T00:00:00Z", items: [] },
      { id: "s1", state: "WAITING_FOR_REVIEW", submitted: "2026-11-20T00:00:00Z", items: ["v101"] },
    ],
  });
  const preload = `import { appendFileSync } from "node:fs";\n(${fakeAppStore})();`;
  const run = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, script, "status"], {
    env: { ...process.env, ASC_KEY: key, ASC_KEY_ID: "key", ASC_ISSUER: "issuer", ASC_FAKE_STATE: JSON.stringify(state), ASC_FAKE_LOG: log },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const versions = run.stdout.split("## App Store versions\n")[1].split("\n\n")[0];
  assert.match(versions, /^1\.0\.0 state=READY_FOR_SALE release=MANUAL build=9/m);
  assert.match(versions, /^1\.0\.1 state=WAITING_FOR_REVIEW release=MANUAL build=12/m);
  const submissions = run.stdout.split("## App Store review submissions\n")[1].split("\n\n")[0].split("\n");
  assert.deepEqual(submissions, ["WAITING_FOR_REVIEW submitted 2026-11-20", "COMPLETE submitted 2026-10-01"]);
});

const draft101 = (changes = {}) => ({ id: "v101", version: "1.0.1", state: "PREPARE_FOR_SUBMISSION", build: "b12", ...changes });
const ready101 = (changes = {}) => appStoreState({ versions: [shippedBefore, draft101()], localizations: { v101: [{ id: "loc", ...listing, whatsNew: "Bug fixes and improvements." }] }, ...changes });

test("app-store submits with its own App Manager key, and says so when Apple refuses the key", () => {
  const refused = appStore(ready101({ forbid: ["POST /v1/reviewSubmissions"] }));
  assert.equal(refused.code, 1);
  assert.match(refused.err, /403 The API key in use does not allow this request/);
  assert.match(refused.err, /App Manager/);
  const workflow = readFileSync(fileURLToPath(new URL("../../../.github/workflows/ios-release.yml", import.meta.url)), "utf8");
  const job = workflow.split("\n  app-store:\n")[1].split(/\n  [a-z-]+:\n/)[0];
  assert.match(job, /secrets\.ASC_APP_MANAGER_KEY_P8/);
  assert.match(job, /secrets\.ASC_APP_MANAGER_KEY_ID/);
  assert.match(job, /secrets\.ASC_APP_MANAGER_ISSUER/);
  assert.doesNotMatch(job, /NOTARY_/);
  assert.match(job, /\[ -z "\$VERSION_INPUT" \] \|\| args\+=\(--version "\$VERSION_INPUT"\)/);
  assert.doesNotMatch(job, /TESTFLIGHT_VERSION/);
  assert.match(job, /--notes-root "\$GITHUB_WORKSPACE"/);
});

test("app-store writes nothing when this version is already in a submitted review submission, whatever the version's state says", () => {
  const submitted = (build) =>
    appStoreState({
      versions: [shippedBefore, draft101({ state: "READY_FOR_REVIEW", build })],
      localizations: { v101: [{ id: "loc", ...listing }] },
      submissions: [{ id: "s1", state: "WAITING_FOR_REVIEW", items: ["v101"] }],
    });
  const same = appStore(submitted("b12"));
  assert.equal(same.code, 0, same.err);
  assert.deepEqual(same.writes, []);
  assert.match(same.out, /already in a review submission that is WAITING_FOR_REVIEW/);
  const other = appStore(submitted("b9"));
  assert.equal(other.code, 1, other.out);
  assert.match(other.err, /version 1\.0\.1 is in a review submission that is WAITING_FOR_REVIEW with build 9, not 12/);
  assert.deepEqual(other.writes, []);
});

test("app-store stops before submitting when the review submissions change while it runs", () => {
  const raced = appStore(ready101({ race: { after: 1, submission: { id: "s9", state: "READY_FOR_REVIEW", items: [] } } }));
  assert.equal(raced.code, 1);
  assert.match(raced.err, /changed while this ran/);
  assert.ok(!raced.steps.some((step) => step.includes("reviewSubmission")), raced.steps.join("\n"));
  const crowded = appStore(ready101({ raceItem: "event:launch" }));
  assert.equal(crowded.code, 1);
  assert.match(crowded.err, /item-made-1-1/);
  assert.ok(!crowded.steps.includes("PATCH /v1/reviewSubmissions/made-1"), crowded.steps.join("\n"));
});

test("app-store reuses only a review submission that holds this version alone or nothing, and lists anything else", () => {
  const empty = appStore(ready101({ submissions: [{ id: "s1", state: "READY_FOR_REVIEW", items: [] }] }));
  assert.equal(empty.code, 0, empty.err);
  assert.deepEqual(empty.steps, ["POST /v1/reviewSubmissionItems", "PATCH /v1/reviewSubmissions/s1"]);
  const cases = [
    [[{ id: "s1", state: "READY_FOR_REVIEW", items: ["event:launch"] }], /review submission s1 is READY_FOR_REVIEW and holds item item-s1-0/],
    [[{ id: "s1", state: "READY_FOR_REVIEW", items: ["v101", "v100"] }], /review submission s1 is READY_FOR_REVIEW and holds version 1\.0\.0/],
    [[{ id: "s1", state: "UNRESOLVED_ISSUES", items: ["v100"] }], /review submission s1 is UNRESOLVED_ISSUES and holds version 1\.0\.0/],
    [[{ id: "s1", state: "UNRESOLVED_ISSUES", items: [] }], /review submission s1 is UNRESOLVED_ISSUES/],
  ];
  for (const [submissions, refusal] of cases) {
    const run = appStore(ready101({ submissions }));
    assert.equal(run.code, 1, `${refusal}: ${run.out}`);
    assert.match(run.err, refusal);
    assert.deepEqual(run.writes, []);
  }
  const rejected = appStore(ready101({ submissions: [{ id: "s1", state: "UNRESOLVED_ISSUES", items: ["v101"] }] }));
  assert.equal(rejected.code, 0, rejected.err);
  assert.deepEqual(rejected.steps, ["PATCH /v1/reviewSubmissions/s1"]);
});

test("app-store makes a new token before the old one runs out during a long wait", () => {
  const run = appStore(
    appStoreState({ clock: true, builds: [{ id: "b12", number: "12", version: "1.0.1", processing: Array(45).fill("PROCESSING") }], versions: [shippedBefore], localizations: { "made-1": [{ id: "loc", ...listing }] } }),
    ["--timeout", "1500"],
  );
  assert.equal(run.code, 0, run.err);
  assert.ok(run.tokens.length >= 2, `${run.tokens.length} tokens`);
  for (const token of run.tokens) assert.ok(token.exp - token.iat <= 1200);
});

test("app-store picks the build of the pinned version by number, whatever other version shares the number", () => {
  const builds = [
    { id: "b12old", number: "12", version: "1.0.0", processing: [] },
    { id: "b12", number: "12", version: "1.0.1", processing: [] },
  ];
  for (const extra of [[], ["--version", "1.0.1"]]) {
    const picked = appStore(appStoreState({ builds, versions: [shippedBefore], localizations: { "made-1": [{ id: "loc", ...listing }] } }), extra);
    assert.equal(picked.code, 0, picked.err);
    assert.deepEqual(picked.writes.find((write) => write.path.endsWith("/relationships/build")).body, { data: { type: "builds", id: "b12" } });
  }
  const missing = appStore(appStoreState({ builds: [builds[0]] }));
  assert.equal(missing.code, 1);
  assert.match(missing.err, /build 12 of 1\.0\.1 is not on App Store Connect \(it is for 1\.0\.0\)/);
});

test("app-store renames only a lone PREPARE_FOR_SUBMISSION draft and lists any other draft", () => {
  const cases = [
    [[shippedBefore, { id: "v102", version: "1.0.2", state: "REJECTED", build: "b9" }], /1\.0\.2 is REJECTED/],
    [[shippedBefore, { id: "v102", version: "1.0.2", state: "METADATA_REJECTED", build: "b9" }], /1\.0\.2 is METADATA_REJECTED/],
    [
      [shippedBefore, { id: "v102", version: "1.0.2", state: "PREPARE_FOR_SUBMISSION" }, { id: "v103", version: "1.0.3", state: "DEVELOPER_REJECTED" }],
      /1\.0\.2 is PREPARE_FOR_SUBMISSION, 1\.0\.3 is DEVELOPER_REJECTED/,
    ],
  ];
  for (const [versions, refusal] of cases) {
    const run = appStore(appStoreState({ versions }));
    assert.equal(run.code, 1, `${refusal}: ${run.out}`);
    assert.match(run.err, refusal);
    assert.deepEqual(run.writes, []);
  }
});

test("app-store counts screenshots inside their sets, and only warns when the notes don't mention ChatGPT", () => {
  const empty = appStore(ready101({ screenshots: [0, 0, { type: "APP_IPAD_PRO_3GEN_129", shots: 1 }] }));
  assert.equal(empty.code, 1);
  assert.match(empty.err, /- en-US iPhone screenshots in APP_IPHONE_61 or APP_IPHONE_67[^\n]*\(2 empty screenshot sets\)/);
  const quiet = appStore(ready101({ review: { ...reviewReady, notes: "Sign in with any account." } }));
  assert.equal(quiet.code, 0, quiet.err);
  assert.match(quiet.out + quiet.err, /warning: [^\n]*Continue with ChatGPT/);
  assert.ok(quiet.steps.includes("PATCH /v1/reviewSubmissions/made-1"));
});

test("app-store reads notes only from inside --notes-root, whatever a symlink or .. says", () => {
  const root = mkdtempSync(join(tmpdir(), "asc-root-"));
  const outside = join(mkdtempSync(join(tmpdir(), "asc-outside-")), "secret.txt");
  writeFileSync(outside, "outside");
  writeFileSync(join(root, "notes.txt"), "Faster tabs.");
  symlinkSync(outside, join(root, "link.txt"));
  for (const notes of [join(root, "link.txt"), join(root, "..", basename(dirname(outside)), "secret.txt"), outside]) {
    const run = appStore(ready101(), ["--notes", notes, "--notes-root", root]);
    assert.equal(run.code, 1, notes);
    assert.match(run.err, /outside/);
    assert.deepEqual(run.writes, []);
  }
  const inside = appStore(ready101(), ["--notes", join(root, "notes.txt"), "--notes-root", root]);
  assert.equal(inside.code, 0, inside.err);
  assert.equal(inside.writes.find((write) => write.path === "/v1/appStoreVersionLocalizations/loc").body.data.attributes.whatsNew, "Faster tabs.");
});

test("app-store marks this version's rejected item resolved before resubmitting, and leaves other items alone", () => {
  const run = appStore(ready101({ submissions: [{ id: "s1", state: "UNRESOLVED_ISSUES", items: ["v101"], itemStates: { v101: "REJECTED" } }] }));
  assert.equal(run.code, 0, run.err);
  assert.deepEqual(run.steps, ["PATCH /v1/reviewSubmissionItems/item-s1-0", "PATCH /v1/reviewSubmissions/s1"]);
  assert.deepEqual(run.writes[0].body, { data: { type: "reviewSubmissionItems", id: "item-s1-0", attributes: { resolved: true } } });
  const clean = appStore(ready101({ submissions: [{ id: "s1", state: "READY_FOR_REVIEW", items: ["v101"] }] }));
  assert.deepEqual(clean.steps, ["PATCH /v1/reviewSubmissions/s1"]);
});

test("app-store counts only screenshots whose upload has finished", () => {
  const ipad = { type: "APP_IPAD_PRO_3GEN_129", shots: 1 };
  const pending = appStore(ready101({ screenshots: [["UPLOAD_COMPLETE", "FAILED"], ipad] }));
  assert.equal(pending.code, 1);
  assert.match(pending.err, /- en-US iPhone screenshots in APP_IPHONE_61 or APP_IPHONE_67[^\n]*\(2 not finished uploading\)/);
  const one = appStore(ready101({ screenshots: [["FAILED", "COMPLETE"], ipad] }));
  assert.equal(one.code, 0, one.err);
});

function fakeIosDir(family, version = "1.0.1", firstBuild = 1) {
  const ios = mkdtempSync(join(tmpdir(), "asc-ios-"));
  mkdirSync(join(ios, "Ardia"));
  mkdirSync(join(ios, "Config"));
  mkdirSync(join(ios, "Ardia.xcodeproj"));
  const plist = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
  writeFileSync(join(ios, "Ardia", "Info.plist"), plist("\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>"));
  writeFileSync(join(ios, "PrivacyInfo.xcprivacy"), plist(""));
  writeFileSync(join(ios, "Config", "Ardia-DefaultBrowser.entitlements"), plist("\t<key>com.apple.developer.web-browser</key>\n\t<true/>"));
  writeFileSync(join(ios, "Config", "release-version"), `${version}\n`);
  writeFileSync(join(ios, "Config", "first-iphone-only-build"), `${firstBuild}\n`);
  const config = (id, name, bundle, value) =>
    `\t\t${id} /* ${name} */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${bundle};\n\t\t\t\tTARGETED_DEVICE_FAMILY = ${value};\n\t\t\t};\n\t\t\tname = ${name};\n\t\t};\n`;
  writeFileSync(
    join(ios, "Ardia.xcodeproj", "project.pbxproj"),
    config("AAA", "Release", "com.ardia.browser.ios.share", '"1,2"') + (family === null ? "" : config("BBB", "Release", "com.ardia.browser.ios", family)) + config("CCC", "Debug", "com.ardia.browser.ios", '"1,2"'),
  );
  return ios;
}

test("app-store stops without submitting when the version's release type, build, version string or state changes before the submit", () => {
  const changes = [{ releaseType: "AFTER_APPROVAL" }, { build: "b9" }, { version: "1.0.9" }, { state: "DEVELOPER_REJECTED" }];
  for (const after of [1, 2]) {
    for (const change of changes) {
      const run = appStore(ready101({ mutate: { after, id: "v101", changes: change } }));
      assert.equal(run.code, 1, `${JSON.stringify(change)} after ${after}: ${run.out}`);
      assert.match(run.err, /changed while this ran/);
      assert.ok(!run.steps.some((step) => step.startsWith("PATCH /v1/reviewSubmissions/")), `${JSON.stringify(change)} after ${after} submitted`);
    }
  }
  const run = appStore(ready101());
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /The release is MANUAL/);
});

test("app-store reads the submission's items again after resolving a rejected item, right before submitting", () => {
  const run = appStore(ready101({ submissions: [{ id: "s1", state: "UNRESOLVED_ISSUES", items: ["v101"], itemStates: { v101: "REJECTED" } }], raceAfterResolve: "event:launch" }));
  assert.equal(run.code, 1, run.out);
  assert.match(run.err, /item-s1-1/);
  assert.ok(!run.steps.includes("PATCH /v1/reviewSubmissions/s1"), run.steps.join("\n"));
});

test("app-store wants a finished screenshot for each device family the app targets", () => {
  const iphoneOnly = { screenshots: [3] };
  const both = appStore(ready101(iphoneOnly), [], fakeIosDir('"1,2"'));
  assert.equal(both.code, 1);
  assert.match(both.err, /- en-US iPad screenshots/);
  assert.doesNotMatch(both.err, /iPhone screenshots/);
  const repoFloor = readFileSync(fileURLToPath(new URL("../ios/Config/first-iphone-only-build", import.meta.url)), "utf8").trim();
  const repo = appStore(
    ready101({ ...iphoneOnly, builds: [{ id: "bfloor", number: repoFloor, version: "1.0.1", processing: [] }], versions: [shippedBefore, draft101({ build: "bfloor" })] }),
    ["--build", repoFloor],
    fileURLToPath(new URL("../ios", import.meta.url)),
  );
  assert.equal(repo.code, 0, repo.err);
  assert.doesNotMatch(repo.out + repo.err, /iPad/);
  const phone = appStore(ready101(iphoneOnly), [], fakeIosDir("1"));
  assert.equal(phone.code, 0, phone.err);
  const tablet = appStore(ready101({ screenshots: [{ type: "APP_IPAD_PRO_3GEN_129", shots: 2 }] }), [], fakeIosDir("2"));
  assert.equal(tablet.code, 0, tablet.err);
  const unknown = appStore(ready101(), [], fakeIosDir(null));
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /TARGETED_DEVICE_FAMILY/);
  assert.deepEqual(unknown.writes, []);
});

test("app-store refuses a build that declares non-exempt encryption without an approved encryption declaration", () => {
  const build = (declaration) => ({ builds: [{ id: "b12", number: "12", version: "1.0.1", processing: [], encryption: true, declaration }] });
  for (const declaration of [null, "IN_REVIEW", "REJECTED"]) {
    const run = appStore(ready101(build(declaration)));
    assert.equal(run.code, 1, `${declaration}: ${run.out}`);
    assert.match(run.err, /non-exempt encryption/);
    assert.match(run.err, new RegExp(declaration ? `declaration is ${declaration}` : "no encryption declaration"));
    assert.deepEqual(run.writes, []);
  }
  const approved = appStore(ready101(build("APPROVED")));
  assert.equal(approved.code, 0, approved.err);
});

test("app-store submits in one go through the states Apple moves the version to for the run's own writes", () => {
  const cases = [
    [{ addItem: "READY_FOR_REVIEW" }, ready101()],
    [{ attach: "READY_FOR_REVIEW", addItem: "READY_FOR_REVIEW" }, ready101({ versions: [shippedBefore, draft101({ build: "b9" })] })],
    [{ addItem: "READY_FOR_REVIEW" }, appStoreState({ versions: [shippedBefore], localizations: { "made-1": [{ id: "loc", ...listing }] } })],
    [
      { attach: "PREPARE_FOR_SUBMISSION", resolve: "READY_FOR_REVIEW" },
      ready101({ versions: [shippedBefore, draft101({ state: "REJECTED", build: "b9" })], submissions: [{ id: "s1", state: "UNRESOLVED_ISSUES", items: ["v101"], itemStates: { v101: "REJECTED" } }] }),
    ],
  ];
  for (const [transitions, state] of cases) {
    const run = appStore({ ...state, transitions });
    assert.equal(run.code, 0, `${JSON.stringify(transitions)}: ${run.err}`);
    assert.ok(run.steps.some((step) => /^PATCH \/v1\/reviewSubmissions\/(made-\d+|s1)$/.test(step)), `${JSON.stringify(transitions)} not submitted`);
  }
});

test("app-store still stops before submitting when the release type, build or review state changes after it adds the version", () => {
  for (const changes of [{ releaseType: "AFTER_APPROVAL" }, { build: "b9" }, { state: "WAITING_FOR_REVIEW" }, { state: "IN_REVIEW" }]) {
    const run = appStore(ready101({ transitions: { addItem: "READY_FOR_REVIEW" }, mutate: { after: 2, id: "v101", changes } }));
    assert.equal(run.code, 1, `${JSON.stringify(changes)}: ${run.out}`);
    assert.match(run.err, /changed while this ran/);
    assert.ok(run.steps.includes("POST /v1/reviewSubmissionItems"), JSON.stringify(changes));
    assert.ok(!run.steps.some((step) => step.startsWith("PATCH /v1/reviewSubmissions/")), `${JSON.stringify(changes)} submitted`);
  }
});

test("app-store checks the build again after submitting and only reports what Apple shows, never cancelling", () => {
  const afterSubmit = (run) => run.writes.slice(run.writes.findIndex((write) => write.body?.data?.attributes?.submitted) + 1);
  const swapped = appStore(ready101({ swapBuildOnSubmit: "b9" }));
  assert.equal(swapped.code, 1, swapped.out);
  assert.match(swapped.err, /review submission made-1/);
  assert.match(swapped.err, /submitted build 12/);
  assert.match(swapped.err, /App Store Connect shows build 9/);
  assert.match(swapped.err, /cancel it in App Store Connect/);
  assert.deepEqual(afterSubmit(swapped), []);
  const released = appStore(ready101({ swapReleaseOnSubmit: "AFTER_APPROVAL" }));
  assert.equal(released.code, 1, released.out);
  assert.match(released.err, /review submission made-1/);
  assert.match(released.err, /submitted build 12/);
  assert.match(released.err, /AFTER_APPROVAL, not MANUAL/);
  assert.doesNotMatch(released.out, /The release is MANUAL/);
  assert.deepEqual(afterSubmit(released), []);
  for (const failure of ["hide", "fail", "network", "garbage"]) {
    const unverified = appStore(ready101({ afterSubmit: failure }));
    assert.equal(unverified.code, 1, `${failure}: ${unverified.out}`);
    assert.match(unverified.err, /review submission made-1/);
    assert.match(unverified.err, /submitted build 12/);
    assert.match(unverified.err, /couldn't confirm/);
    assert.deepEqual(afterSubmit(unverified), [], failure);
    assert.ok(!unverified.writes.some((write) => write.body?.data?.attributes?.canceled), failure);
  }
  const clean = appStore(ready101());
  assert.equal(clean.code, 0, clean.err);
  assert.deepEqual(afterSubmit(clean), []);
});

test("app-store reads the attached build again after finding the version in review, and counts it done only with the requested build", () => {
  const builds = [...appStoreState().builds, { id: "b13", number: "13", version: "1.0.1", processing: [] }];
  const inReview = (mutate) =>
    appStoreState({
      builds,
      versions: [shippedBefore, draft101({ state: "READY_FOR_REVIEW", build: "b12" })],
      localizations: { v101: [{ id: "loc", ...listing }] },
      submissions: [{ id: "s1", state: "WAITING_FOR_REVIEW", items: ["v101"] }],
      mutate,
    });
  const switched = appStore(inReview({ after: 1, id: "v101", changes: { build: "b13" } }));
  assert.equal(switched.code, 1, switched.out);
  assert.match(switched.err, /with build 13, not 12/);
  assert.deepEqual(switched.writes, []);
  const same = appStore(inReview(undefined));
  assert.equal(same.code, 0, same.err);
  assert.deepEqual(same.writes, []);
});

test("app-store wants a finished screenshot in the Dynamic Island medium or large class, not any iPhone class", () => {
  const smaller = appStore(ready101({ screenshots: [{ type: "APP_IPHONE_65", shots: 3 }, { type: "APP_IPHONE_55", shots: 2 }, { type: "APP_IPHONE_61", shots: ["FAILED"] }] }));
  assert.equal(smaller.code, 1, smaller.out);
  assert.match(smaller.err, /- en-US iPhone screenshots in APP_IPHONE_61 or APP_IPHONE_67, iPhone with Dynamic Island \(medium or large display\) \(1 not finished uploading; only APP_IPHONE_65, APP_IPHONE_55 finished, which App Review doesn't take in their place\)/);
  assert.ok(!smaller.steps.some((step) => step.startsWith("PATCH /v1/reviewSubmissions/")), smaller.steps.join("\n"));
  for (const type of ["APP_IPHONE_61", "APP_IPHONE_67"]) {
    const run = appStore(ready101({ screenshots: [{ type, shots: 1 }, { type: "APP_IPHONE_65", shots: ["FAILED"] }] }));
    assert.equal(run.code, 0, `${type}: ${run.err}`);
  }
});

const STORE_FIXTURE = fileURLToPath(new URL("./fixtures/store", import.meta.url));
const pngCache = new Map();

function png(width, height, { shade = 40, alpha = false, filter = 0 } = {}) {
  const key = `${width}x${height}:${shade}:${alpha}:${filter}`;
  if (pngCache.has(key)) return pngCache.get(key);
  const channels = alpha ? 4 : 3;
  const row = Buffer.alloc(1 + width * channels, shade);
  row[0] = filter;
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = alpha ? 6 : 2;
  const bytes = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  pngCache.set(key, bytes);
  return bytes;
}

function storeDir({ medium = [png(1206, 2622, { shade: 10 }), png(1206, 2622, { shade: 20 })], large = [png(1320, 2868, { shade: 30 })], text = {}, listing: changes = {} } = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), "asc-store-")), "store");
  cpSync(STORE_FIXTURE, dir, { recursive: true });
  for (const [file, value] of Object.entries(text)) writeFileSync(join(dir, "en-US", file), value);
  const listing = { ...JSON.parse(readFileSync(join(dir, "listing.json"), "utf8")), ...changes };
  writeFileSync(join(dir, "listing.json"), JSON.stringify(listing));
  for (const [kind, shots] of [["iphone-medium", medium], ["iphone-large", large]]) {
    mkdirSync(join(dir, "screenshots", kind), { recursive: true });
    shots.forEach((bytes, at) => writeFileSync(join(dir, "screenshots", kind, `${String(at + 1).padStart(2, "0")}-shot.png`), bytes));
  }
  return dir;
}

function fakeListing() {
  const file = process.env.ASC_FAKE_STATE_FILE;
  const state = JSON.parse(readFileSync(file, "utf8"));
  const log = (entry) => appendFileSync(process.env.ASC_FAKE_LOG, `${JSON.stringify(entry)}\n`);
  globalThis.setTimeout = (resume) => queueMicrotask(resume);
  const reply = (data, status = 200, included) => new Response(data === undefined ? null : JSON.stringify({ data, included }), { status });
  const missing = () => new Response(JSON.stringify({ errors: [{ detail: "The specified resource does not exist" }] }), { status: 404 });
  const made = (kind) => `${kind}-${++state.made}`;
  const row = (type, item, relationships) => {
    const { id, ...attributes } = item;
    return { id, type, attributes, ...(relationships ? { relationships } : {}) };
  };
  const shotRow = (shot) => ({ id: shot.id, type: "appScreenshots", attributes: { fileName: shot.fileName, ...(shot.checksum === undefined ? {} : { sourceFileChecksum: shot.checksum }), assetDeliveryState: { state: shot.state } } });
  const route = (method, path, searchParams, body, init) => {
    if (path === "/v1/apps" && method === "GET") {
      return reply([{ id: "app", type: "apps", attributes: { bundleId: "com.ardia.browser.ios", name: "Ardia", primaryLocale: "en-US", contentRightsDeclaration: state.contentRights } }]);
    }
    if (path === "/v1/apps/app" && method === "PATCH") {
      state.contentRights = body.data.attributes.contentRightsDeclaration;
      return reply({ id: "app", type: "apps" });
    }
    if (path === "/v1/apps/app/appStoreVersions") {
      return reply(state.versions.map((version) => ({ id: version.id, type: "appStoreVersions", attributes: { versionString: version.version, appVersionState: version.state, releaseType: "MANUAL", copyright: version.copyright ?? null }, relationships: { build: { data: null } } })), 200, []);
    }
    if (path === "/v1/appStoreVersions" && method === "POST") {
      state.versions.push({ id: made("version"), version: body.data.attributes.versionString, state: "PREPARE_FOR_SUBMISSION", releaseType: body.data.attributes.releaseType, copyright: body.data.attributes.copyright ?? null });
      return reply({ id: state.versions.at(-1).id, type: "appStoreVersions", attributes: body.data.attributes }, 201);
    }
    let match = path.match(/^\/v1\/appStoreVersions\/([^/]+)$/);
    if (match && method === "PATCH") {
      const edited = state.versions.find((version) => version.id === match[1]);
      const { versionString, ...rest } = body.data.attributes;
      Object.assign(edited, rest, versionString === undefined ? {} : { version: versionString });
      return reply({ id: match[1], type: "appStoreVersions" });
    }
    match = path.match(/^\/v1\/appStoreVersions\/([^/]+)\/appStoreVersionLocalizations$/);
    if (match) return reply(state.versionLocalizations.filter((entry) => entry.version === match[1]).map(({ version, ...entry }) => row("appStoreVersionLocalizations", entry)));
    if (path === "/v1/appStoreVersionLocalizations" && method === "POST") {
      state.versionLocalizations.push({ id: made("vloc"), version: body.data.relationships.appStoreVersion.data.id, ...body.data.attributes });
      return reply({ id: state.versionLocalizations.at(-1).id, type: "appStoreVersionLocalizations" }, 201);
    }
    match = path.match(/^\/v1\/appStoreVersionLocalizations\/([^/]+)$/);
    if (match && method === "PATCH") {
      Object.assign(state.versionLocalizations.find((entry) => entry.id === match[1]), body.data.attributes);
      return reply({ id: match[1], type: "appStoreVersionLocalizations" });
    }
    if (path === "/v1/apps/app/appInfos") {
      const link = (id) => ({ data: id ? { type: "appCategories", id } : null });
      return reply(state.appInfos.map((info) => ({ id: info.id, type: "appInfos", attributes: { state: info.state }, relationships: { primaryCategory: link(info.primaryCategory), secondaryCategory: link(info.secondaryCategory) } })));
    }
    match = path.match(/^\/v1\/appInfos\/([^/]+)(.*)$/);
    if (match && match[2] === "/appInfoLocalizations") return reply(state.infoLocalizations.filter((entry) => entry.info === match[1]).map(({ info, ...entry }) => row("appInfoLocalizations", entry)));
    if (match && match[2] === "/ageRatingDeclaration") return reply({ id: "age", type: "ageRatingDeclarations", attributes: state.ageRating });
    if (match && match[2] === "" && method === "PATCH") {
      const info = state.appInfos.find((entry) => entry.id === match[1]);
      for (const [key, link] of Object.entries(body.data.relationships)) info[key] = link.data?.id ?? null;
      return reply({ id: info.id, type: "appInfos" });
    }
    if (path === "/v1/appInfoLocalizations" && method === "POST") {
      state.infoLocalizations.push({ id: made("iloc"), info: body.data.relationships.appInfo.data.id, ...body.data.attributes });
      return reply({ id: state.infoLocalizations.at(-1).id, type: "appInfoLocalizations" }, 201);
    }
    match = path.match(/^\/v1\/appInfoLocalizations\/([^/]+)$/);
    if (match && method === "PATCH") {
      Object.assign(state.infoLocalizations.find((entry) => entry.id === match[1]), body.data.attributes);
      return reply({ id: match[1], type: "appInfoLocalizations" });
    }
    if (path === "/v1/ageRatingDeclarations/age" && method === "PATCH") {
      Object.assign(state.ageRating, body.data.attributes);
      return reply({ id: "age", type: "ageRatingDeclarations" });
    }
    if (path === "/v1/apps/app/appPriceSchedule") {
      return state.price ? reply({ id: "schedule", type: "appPriceSchedules", relationships: { baseTerritory: { data: { type: "territories", id: state.price.base } } } }) : missing();
    }
    if (path === "/v1/appPriceSchedules/schedule/manualPrices") {
      return reply(
        [{ id: "price", type: "appPrices", attributes: { startDate: state.price.start ?? null, endDate: state.price.end ?? null }, relationships: { appPricePoint: { data: { type: "appPricePoints", id: state.price.point } } } }],
        200,
        state.pricePoints.filter((point) => point.id === state.price.point).map((point) => ({ id: point.id, type: "appPricePoints", attributes: { customerPrice: point.customerPrice } })),
      );
    }
    if (path === "/v1/apps/app/appPricePoints") {
      return reply(state.pricePoints.filter((point) => point.territory === searchParams.get("filter[territory]")).map((point) => ({ id: point.id, type: "appPricePoints", attributes: { customerPrice: point.customerPrice } })));
    }
    if (path === "/v1/appPriceSchedules" && method === "POST") {
      state.price = { base: body.data.relationships.baseTerritory.data.id, point: body.included[0].relationships.appPricePoint.data.id };
      return reply({ id: "schedule", type: "appPriceSchedules" }, 201);
    }
    if (path === "/v1/territories") return reply(state.territories.map((id) => ({ id, type: "territories", attributes: { currency: "USD" } })));
    if (path === "/v1/apps/app/appAvailabilityV2") {
      return state.availability ? reply({ id: "availability", type: "appAvailabilities", attributes: { availableInNewTerritories: state.availability.newTerritories } }) : missing();
    }
    if (path === "/v2/appAvailabilities" && method === "POST") {
      state.availability = {
        newTerritories: body.data.attributes.availableInNewTerritories,
        territories: body.included.map((entry) => ({ id: `ta-${entry.relationships.territory.data.id}`, territory: entry.relationships.territory.data.id, available: entry.attributes.available })),
      };
      return reply({ id: "availability", type: "appAvailabilities" }, 201);
    }
    if (path === "/v2/appAvailabilities/availability/territoryAvailabilities") {
      return reply(state.availability.territories.map((entry) => ({ id: entry.id, type: "territoryAvailabilities", attributes: { available: entry.available }, relationships: { territory: { data: { type: "territories", id: entry.territory } } } })));
    }
    match = path.match(/^\/v1\/territoryAvailabilities\/([^/]+)$/);
    if (match && method === "PATCH") {
      state.availability.territories.find((entry) => entry.id === match[1]).available = body.data.attributes.available;
      return reply({ id: match[1], type: "territoryAvailabilities" });
    }
    match = path.match(/^\/v1\/appStoreVersions\/([^/]+)\/appStoreReviewDetail$/);
    if (match) {
      const detail = state.review?.version === match[1] ? state.review : null;
      if (!detail) return reply(null);
      const { version, ...attributes } = detail;
      return reply(row("appStoreReviewDetails", attributes));
    }
    if (state.reviewError && path.startsWith("/v1/appStoreReviewDetails") && method !== "GET") {
      return new Response(JSON.stringify({ errors: [{ status: "422", code: "ENTITY_ERROR.ATTRIBUTE.INVALID", title: "An attribute value is invalid.", detail: `Phone must be international: ${state.reviewError}`, source: { pointer: "/data/attributes/contactPhone" } }] }), { status: 422 });
    }
    if (path === "/v1/appStoreReviewDetails" && method === "POST") {
      state.review = { id: "review", version: body.data.relationships.appStoreVersion.data.id, ...body.data.attributes };
      return reply({ id: "review", type: "appStoreReviewDetails" }, 201);
    }
    if (path === "/v1/appStoreReviewDetails/review" && method === "PATCH") {
      Object.assign(state.review, body.data.attributes);
      return reply({ id: "review", type: "appStoreReviewDetails" });
    }
    match = path.match(/^\/v1\/appStoreVersionLocalizations\/([^/]+)\/appScreenshotSets$/);
    if (match) {
      const sets = state.sets.filter((set) => set.localization === match[1]);
      return reply(
        sets.map((set) => ({ id: set.id, type: "appScreenshotSets", attributes: { screenshotDisplayType: set.type }, relationships: { appScreenshots: { data: set.shots.map((id) => ({ type: "appScreenshots", id })) } } })),
        200,
        sets.flatMap((set) => set.shots.map((id) => shotRow(state.shots[id]))),
      );
    }
    if (path === "/v1/appScreenshotSets" && method === "POST") {
      state.sets.push({ id: made("set"), localization: body.data.relationships.appStoreVersionLocalization.data.id, type: body.data.attributes.screenshotDisplayType, shots: [] });
      return reply({ id: state.sets.at(-1).id, type: "appScreenshotSets" }, 201);
    }
    match = path.match(/^\/v1\/appScreenshotSets\/([^/]+)\/relationships\/appScreenshots$/);
    if (match && method === "PATCH") {
      state.sets.find((set) => set.id === match[1]).shots = body.data.map((link) => link.id);
      return reply(undefined, 204);
    }
    if (path === "/v1/appScreenshots" && method === "POST") {
      const target = state.sets.find((set) => set.id === body.data.relationships.appScreenshotSet.data.id);
      if (target.shots.length >= 10) return new Response(JSON.stringify({ errors: [{ status: "409", code: "ENTITY_ERROR", detail: "A screenshot set holds at most 10 screenshots" }] }), { status: 409 });
      const id = made("shot");
      const { fileName, fileSize } = body.data.attributes;
      const half = Math.ceil(fileSize / 2);
      state.shots[id] = { id, fileName, fileSize, received: 0, checksum: null, state: "AWAITING_UPLOAD", polls: 0 };
      state.sets.find((set) => set.id === body.data.relationships.appScreenshotSet.data.id).shots.push(id);
      const operation = (offset, length) => ({ method: "PUT", url: `https://upload.test/${id}/${offset}`, offset, length, requestHeaders: [{ name: "Content-Type", value: "image/png" }] });
      return reply({ id, type: "appScreenshots", attributes: { fileName, fileSize, uploadOperations: [operation(0, half), operation(half, fileSize - half)] } }, 201);
    }
    match = path.match(/^\/v1\/appScreenshots\/([^/]+)$/);
    const shot = match && state.shots[match[1]];
    if (shot && method === "PATCH") {
      shot.checksum = body.data.attributes.sourceFileChecksum;
      if (body.data.attributes.uploaded) shot.state = shot.received === shot.fileSize ? "UPLOAD_COMPLETE" : "FAILED";
      return reply(shotRow(shot));
    }
    if (shot && method === "GET") {
      if (shot.state === "UPLOAD_COMPLETE" && state.failProcessing > 0) {
        state.failProcessing--;
        shot.state = "FAILED";
      }
      if (shot.state === "UPLOAD_COMPLETE" && ++shot.polls >= 2) shot.state = "COMPLETE";
      return reply(shotRow(shot));
    }
    if (shot && method === "DELETE") {
      for (const set of state.sets) set.shots = set.shots.filter((id) => id !== shot.id);
      delete state.shots[shot.id];
      return reply(undefined, 204);
    }
    return missing();
  };
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const { hostname, pathname: path, searchParams } = new URL(url);
    const authorized = Object.keys(init.headers ?? {}).some((name) => name.toLowerCase() === "authorization");
    if (hostname === "upload.test") {
      const [, id, offset] = path.split("/");
      if (state.failUploads > 0) {
        state.failUploads--;
        log({ method, path: `upload.test${path}`, failed: true, authorized });
        writeFileSync(file, JSON.stringify(state));
        return new Response(null, { status: 503 });
      }
      state.shots[id].received += init.body.length;
      log({ method, path: `upload.test${path}`, length: init.body.length, offset: Number(offset), authorized });
      writeFileSync(file, JSON.stringify(state));
      return new Response(null, { status: 200 });
    }
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    log(method === "GET" ? { method, path } : { method, path, body });
    const response = route(method, path, searchParams, body, init);
    writeFileSync(file, JSON.stringify(state));
    return response;
  };
}

function listingState(changes = {}) {
  return {
    made: 0,
    contentRights: null,
    versions: [],
    versionLocalizations: [],
    appInfos: [{ id: "info", state: "PREPARE_FOR_SUBMISSION", primaryCategory: null, secondaryCategory: null }],
    infoLocalizations: [{ id: "iloc", info: "info", locale: "en-US", name: "Ardia", subtitle: null, privacyPolicyUrl: null }],
    ageRating: { advertising: null, gambling: null, lootBox: null, unrestrictedWebAccess: null, violenceRealistic: null, userGeneratedContent: null },
    price: null,
    pricePoints: [
      { id: "point-paid", territory: "USA", customerPrice: "0.99" },
      { id: "point-free", territory: "USA", customerPrice: "0.0" },
      { id: "point-free-gbr", territory: "GBR", customerPrice: "0.0" },
    ],
    territories: ["USA", "GBR", "IND"],
    availability: null,
    review: null,
    sets: [],
    shots: {},
    ...changes,
  };
}

const CONTACT = { ASC_REVIEW_CONTACT_FIRST_NAME: "Quillon", ASC_REVIEW_CONTACT_LAST_NAME: "Marrowby", ASC_REVIEW_CONTACT_PHONE: "+1 555 010 0100", ASC_REVIEW_CONTACT_EMAIL: "contact@example.com" };
const NO_CONTACT = Object.fromEntries(Object.keys(CONTACT).map((name) => [name, ""]));

function listingRun(state, { store = storeDir(), contact = CONTACT, extra = [], key = true, ios = fakeIosDir("1") } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "asc-"));
  const keyPath = join(dir, "AuthKey.p8");
  writeFileSync(keyPath, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const stateFile = typeof state === "string" ? state : join(dir, "state.json");
  if (typeof state !== "string") writeFileSync(stateFile, JSON.stringify(state));
  const preload = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";\n(${fakeListing})();`;
  const run = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, script, "listing", "--store", store, "--ios-dir", ios, ...extra], {
    env: { ...process.env, ...(key ? { ASC_KEY: keyPath, ASC_KEY_ID: "key", ASC_ISSUER: "issuer" } : { ASC_KEY: "", ASC_KEY_ID: "", ASC_ISSUER: "" }), ...contact, ASC_FAKE_STATE_FILE: stateFile, ASC_FAKE_LOG: log },
    encoding: "utf8",
  });
  const requests = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const writes = requests.filter((entry) => entry.method !== "GET");
  return { code: run.status, out: run.stdout, err: run.stderr, requests, writes, steps: writes.map((write) => `${write.method} ${write.path}`), stateFile, state: JSON.parse(readFileSync(stateFile, "utf8")) };
}

const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");
const fixtureText = (file) => readFileSync(join(STORE_FIXTURE, "en-US", file), "utf8").trim();

test("listing pushes the text, URLs, categories, age rating, rights, free price, availability, review details and screenshots from the repo", () => {
  const store = storeDir();
  const run = listingRun(listingState(), { store });
  assert.equal(run.code, 0, run.err);
  const version = run.writes.find((write) => write.path === "/v1/appStoreVersions");
  assert.deepEqual(version.body.data.attributes, { platform: "IOS", versionString: "1.0.1", releaseType: "MANUAL", copyright: "2026 Example" });
  assert.deepEqual(run.state.versionLocalizations.map(({ id, version: _, ...entry }) => entry), [
    {
      locale: "en-US",
      description: fixtureText("description.txt"),
      keywords: fixtureText("keywords.txt"),
      supportUrl: "https://example.com/support",
      promotionalText: fixtureText("promotional-text.txt"),
      marketingUrl: "https://example.com",
    },
  ]);
  assert.deepEqual(run.state.infoLocalizations[0], { id: "iloc", info: "info", locale: "en-US", name: "Ardia", subtitle: fixtureText("subtitle.txt"), privacyPolicyUrl: "https://example.com/privacy" });
  assert.deepEqual([run.state.appInfos[0].primaryCategory, run.state.appInfos[0].secondaryCategory], ["UTILITIES", "PRODUCTIVITY"]);
  assert.deepEqual(run.writes.find((write) => write.path === "/v1/ageRatingDeclarations/age").body.data.attributes, { advertising: false, gambling: false, lootBox: false, unrestrictedWebAccess: true, violenceRealistic: "NONE" });
  assert.equal(run.state.ageRating.userGeneratedContent, null);
  assert.equal(run.state.contentRights, "DOES_NOT_USE_THIRD_PARTY_CONTENT");
  assert.deepEqual(run.state.price, { base: "USA", point: "point-free" });
  assert.deepEqual(run.state.availability, {
    newTerritories: true,
    territories: ["USA", "GBR", "IND"].map((territory) => ({ id: `ta-${territory}`, territory, available: true })),
  });
  const { id, version: reviewed, ...review } = run.state.review;
  assert.equal(reviewed, run.state.versions[0].id);
  assert.deepEqual(review, { notes: fixtureText("review-notes.txt"), demoAccountRequired: false, contactFirstName: "Quillon", contactLastName: "Marrowby", contactPhone: "+1 555 010 0100", contactEmail: "contact@example.com" });
  for (const value of Object.values(CONTACT)) assert.ok(!run.out.includes(value) && !run.err.includes(value), "contact details never printed");
  const sets = Object.fromEntries(run.state.sets.map((set) => [set.type, set.shots.map((shot) => run.state.shots[shot])]));
  assert.deepEqual(Object.keys(sets).sort(), ["APP_IPHONE_61", "APP_IPHONE_67"]);
  const medium = [png(1206, 2622, { shade: 10 }), png(1206, 2622, { shade: 20 })];
  assert.deepEqual(sets.APP_IPHONE_61.map((shot) => [shot.fileName, shot.checksum, shot.state, shot.received === shot.fileSize]), medium.map((bytes, at) => [`0${at + 1}-shot.png`, md5(bytes), "COMPLETE", true]));
  assert.deepEqual(sets.APP_IPHONE_67.map((shot) => shot.checksum), [md5(png(1320, 2868, { shade: 30 }))]);
  const uploads = run.requests.filter((entry) => entry.path.startsWith("upload.test"));
  assert.equal(uploads.length, 6);
  assert.ok(uploads.every((upload) => !upload.authorized), "the upload never carries the App Store Connect token");
  assert.match(run.out, /still by hand in App Store Connect:\n- App Privacy/);
  assert.doesNotMatch(run.out, /App Review contact skipped/);
});

test("listing run again on what it wrote changes nothing", () => {
  const store = storeDir();
  const first = listingRun(listingState(), { store });
  assert.equal(first.code, 0, first.err);
  const again = listingRun(first.stateFile, { store });
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(again.writes, []);
  assert.match(again.out, /already matched the repo; nothing was written/);
});

test("listing replaces only the screenshot set whose files changed, and reorders one whose order alone changed", () => {
  const first = listingRun(listingState(), { store: storeDir() });
  assert.equal(first.code, 0, first.err);
  const oldMedium = first.state.sets.find((set) => set.type === "APP_IPHONE_61").shots;
  const changed = listingRun(first.stateFile, { store: storeDir({ medium: [png(1206, 2622, { shade: 10 }), png(1206, 2622, { shade: 99 })] }) });
  assert.equal(changed.code, 0, changed.err);
  assert.deepEqual(changed.steps.filter((step) => step.startsWith("DELETE")), [`DELETE /v1/appScreenshots/${oldMedium[1]}`]);
  assert.equal(changed.steps.filter((step) => step === "POST /v1/appScreenshots").length, 1);
  assert.ok(changed.steps.indexOf("POST /v1/appScreenshots") < changed.steps.findIndex((step) => step.startsWith("DELETE")), "the new screenshot is uploaded before the old one goes");
  assert.ok(!changed.steps.some((step) => step.startsWith("POST /v1/appScreenshotSets")));
  const large = changed.state.sets.find((set) => set.type === "APP_IPHONE_67");
  assert.deepEqual(large.shots, first.state.sets.find((set) => set.type === "APP_IPHONE_67").shots, "the large set is left alone");
  assert.deepEqual(changed.state.sets.find((set) => set.type === "APP_IPHONE_61").shots.map((id) => changed.state.shots[id].checksum), [md5(png(1206, 2622, { shade: 10 })), md5(png(1206, 2622, { shade: 99 }))]);
  assert.ok(changed.steps.every((step) => !/appStoreVersionLocalizations\/|appInfo|ageRating|appPriceSchedules|appAvailabilities|appStoreReviewDetails|\/v1\/apps\//.test(step)), changed.steps.join("\n"));
  const before = changed.state.sets.find((set) => set.type === "APP_IPHONE_61").shots;
  const swapped = listingRun(changed.stateFile, { store: storeDir({ medium: [png(1206, 2622, { shade: 99 }), png(1206, 2622, { shade: 10 })] }) });
  assert.equal(swapped.code, 0, swapped.err);
  assert.deepEqual(swapped.writes.map((write) => [write.method, write.path, write.body?.data?.map((link) => link.id)]), [["PATCH", `/v1/appScreenshotSets/${changed.state.sets.find((set) => set.type === "APP_IPHONE_61").id}/relationships/appScreenshots`, before.toReversed()]]);
});

test("listing refuses text over Apple's limits, bad URLs, a wrong size, alpha and an unknown answer before any request", () => {
  const store = storeDir({
    medium: [png(1206, 2622), png(1290, 2796), png(1206, 2622, { alpha: true })],
    text: { "subtitle.txt": "s".repeat(31), "keywords.txt": "k".repeat(101), "description.txt": "d".repeat(4001), "promotional-text.txt": "p".repeat(171), "review-notes.txt": "n".repeat(4001) },
    listing: { supportUrl: "http://example.com/support", price: "0.99", ageRating: { advertising: false, spaceTravel: true }, contentRights: "MAYBE" },
  });
  writeFileSync(join(store, "screenshots", "iphone-large", "shot.jpg"), "x");
  for (const run of [listingRun(listingState(), { store }), listingRun(listingState(), { store, extra: ["--check"], key: false })]) {
    assert.equal(run.code, 1, run.out);
    for (const problem of [
      /subtitle\.txt has 31 characters; the subtitle takes at most 30/,
      /keywords\.txt has 101 bytes; the keywords take at most 100/,
      /description\.txt has 4001 characters; the description takes at most 4000/,
      /promotional-text\.txt has 171 characters; the promotional text takes at most 170/,
      /review-notes\.txt has 4001 bytes; App Review notes take at most 4000/,
      /supportUrl must be an https URL/,
      /price must be "free"/,
      /ageRating has an unknown answer spaceTravel/,
      /contentRights must be/,
      /02-shot\.png is 1290×2796; iPhone with Dynamic Island \(medium display\) takes 1206×2622, 1179×2556/,
      /03-shot\.png has an alpha channel/,
      /shot\.jpg isn't a screenshot named NN-<name>\.png/,
    ]) {
      assert.match(run.err, problem);
    }
    assert.deepEqual(run.requests, []);
  }
  const fine = listingRun(listingState(), { extra: ["--check"], key: false });
  assert.equal(fine.code, 0, fine.err);
  assert.match(fine.out, /listing checked: version 1\.0\.1, en-US, screenshots 2 APP_IPHONE_61, 1 APP_IPHONE_67/);
  assert.deepEqual(fine.requests, []);
  const none = listingRun(listingState(), { store: storeDir({ medium: [], large: [] }), extra: ["--check"], key: false });
  assert.equal(none.code, 1);
  assert.match(none.err, /has no iPhone screenshots: App Review needs APP_IPHONE_61 or APP_IPHONE_67/);
});

test("listing skips the App Review contact with a note when its secrets are unset, and never makes them up", () => {
  for (const contact of [NO_CONTACT, { ...NO_CONTACT, ASC_REVIEW_CONTACT_EMAIL: "contact@example.com" }]) {
    const run = listingRun(listingState(), { contact });
    assert.equal(run.code, 0, run.err);
    const { id, version, ...review } = run.state.review;
    assert.deepEqual(review, { notes: fixtureText("review-notes.txt"), demoAccountRequired: false });
    assert.match(run.out, /App Review contact skipped: ASC_REVIEW_CONTACT_FIRST_NAME, ASC_REVIEW_CONTACT_LAST_NAME, ASC_REVIEW_CONTACT_PHONE[^\n]* unset/);
    assert.match(run.out, /- App Review contact: set ASC_REVIEW_CONTACT_FIRST_NAME/);
    assert.doesNotMatch(run.out, /contact@example\.com/);
  }
  const bad = listingRun(listingState(), { contact: { ...CONTACT, ASC_REVIEW_CONTACT_EMAIL: "not-an-email" } });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /ASC_REVIEW_CONTACT_EMAIL isn't an email address/);
  assert.doesNotMatch(bad.err, /not-an-email/);
  assert.deepEqual(bad.requests, []);
});

test("listing renames a lone draft, refuses a version in review, and makes the app free and available where it wasn't", () => {
  const renamed = listingRun(listingState({ versions: [{ id: "v100", version: "1.0", state: "PREPARE_FOR_SUBMISSION" }] }));
  assert.equal(renamed.code, 0, renamed.err);
  assert.deepEqual(renamed.writes[0], { method: "PATCH", path: "/v1/appStoreVersions/v100", body: { data: { type: "appStoreVersions", id: "v100", attributes: { versionString: "1.0.1", copyright: "2026 Example" } } } });
  assert.ok(!renamed.steps.includes("POST /v1/appStoreVersions"));
  for (const state of ["WAITING_FOR_REVIEW", "IN_REVIEW"]) {
    const run = listingRun(listingState({ versions: [{ id: "v101", version: "1.0.1", state }] }));
    assert.equal(run.code, 1, run.out);
    assert.match(run.err, new RegExp(`version 1\\.0\\.1 is ${state}; its listing can't change`));
    assert.deepEqual(run.writes, []);
  }
  const partly = listingRun(
    listingState({
      price: { base: "USA", point: "point-paid" },
      availability: { newTerritories: false, territories: [{ id: "ta-USA", territory: "USA", available: true }, { id: "ta-GBR", territory: "GBR", available: false }] },
    }),
  );
  assert.equal(partly.code, 0, partly.err);
  assert.deepEqual(partly.state.price, { base: "USA", point: "point-free" });
  assert.deepEqual(partly.steps.filter((step) => step.includes("territoryAvailabilities")), ["PATCH /v1/territoryAvailabilities/ta-GBR"]);
  assert.match(partly.out, /1 territory isn't in the app's availability \(IND\)/);
  assert.match(partly.out, /turn on availability in new territories/);
});

test("round 5: app-store never reports success for a version in review whose release isn't manual, and writes nothing", () => {
  for (const state of ["WAITING_FOR_REVIEW", "IN_REVIEW", "PENDING_DEVELOPER_RELEASE"]) {
    const run = appStore(appStoreState({ versions: [{ id: "v101", version: "1.0.1", state, build: "b12", releaseType: "AFTER_APPROVAL" }] }));
    assert.equal(run.code, 1, `${state}: ${run.out}`);
    assert.match(run.err, /release is AFTER_APPROVAL[^\n]*set it to Manual in App Store Connect/);
    assert.deepEqual(run.writes, []);
  }
  const submitted = appStore(
    appStoreState({
      versions: [shippedBefore, draft101({ state: "READY_FOR_REVIEW", releaseType: "AFTER_APPROVAL" })],
      localizations: { v101: [{ id: "loc", ...listing }] },
      submissions: [{ id: "s1", state: "WAITING_FOR_REVIEW", items: ["v101"] }],
    }),
  );
  assert.equal(submitted.code, 1, submitted.out);
  assert.match(submitted.err, /release is AFTER_APPROVAL[^\n]*set it to Manual in App Store Connect/);
  assert.deepEqual(submitted.writes, []);
});

test("round 5: app-store wants the version's copyright before it submits", () => {
  const run = appStore(ready101({ versions: [shippedBefore, draft101({ copyright: null })] }));
  assert.equal(run.code, 1, run.out);
  assert.match(run.err, /- version 1\.0\.1 copyright/);
  assert.ok(!run.steps.some((step) => step.includes("reviewSubmission")), run.steps.join("\n"));
});

test("round 5: app-store refuses a build made before the app became iPhone only", () => {
  const ios = fakeIosDir("1", "1.0.1", 13);
  const old = appStore(ready101(), [], ios);
  assert.equal(old.code, 1, old.out);
  assert.match(old.err, /build 12 is older than build 13, the first iPhone-only build/);
  assert.deepEqual(old.writes, []);
  const builds = [...appStoreState().builds, { id: "b13", number: "13", version: "1.0.1", processing: [] }];
  const fresh = appStore(ready101({ builds, versions: [shippedBefore, draft101({ build: "b13" })] }), ["--build", "13"], ios);
  const edge = appStore(ready101(), [], fakeIosDir("1", "1.0.1", 12));
  assert.equal(edge.code, 0, edge.err);
  assert.equal(fresh.code, 0, fresh.err);
  const repo = readFileSync(fileURLToPath(new URL("../ios/Config/first-iphone-only-build", import.meta.url)), "utf8");
  assert.match(repo, /^[1-9]\d*\n$/);
});

test("round 5: listing sets the version's copyright from listing.json and leaves a matching one alone", () => {
  const first = listingRun(listingState());
  assert.equal(first.code, 0, first.err);
  assert.equal(first.writes.find((write) => write.path === "/v1/appStoreVersions").body.data.attributes.copyright, "2026 Example");
  const drifted = JSON.parse(readFileSync(first.stateFile, "utf8"));
  drifted.versions[0].copyright = "2025 Someone";
  writeFileSync(first.stateFile, JSON.stringify(drifted));
  const fixed = listingRun(first.stateFile);
  assert.equal(fixed.code, 0, fixed.err);
  assert.deepEqual(fixed.writes.map((write) => [write.path, write.body.data.attributes]), [[`/v1/appStoreVersions/${drifted.versions[0].id}`, { copyright: "2026 Example" }]]);
});

test("round 5: a failed screenshot upload keeps the old set, and a partial match keeps what matches", () => {
  const first = listingRun(listingState(), { store: storeDir() });
  assert.equal(first.code, 0, first.err);
  const medium = (run) => run.state.sets.find((set) => set.type === "APP_IPHONE_61");
  const before = medium(first).shots;
  const broken = JSON.parse(readFileSync(first.stateFile, "utf8"));
  broken.failUploads = 1;
  writeFileSync(first.stateFile, JSON.stringify(broken));
  const replacement = storeDir({ medium: [png(1206, 2622, { shade: 10 }), png(1206, 2622, { shade: 77 })] });
  const failed = listingRun(first.stateFile, { store: replacement });
  assert.equal(failed.code, 1, failed.out);
  assert.match(failed.err, /uploading 02-shot\.png failed with 503/);
  assert.ok(!failed.steps.some((step) => step.startsWith("DELETE")), failed.steps.join("\n"));
  for (const id of before) assert.equal(failed.state.shots[id].state, "COMPLETE");
  const retried = listingRun(first.stateFile, { store: replacement });
  assert.equal(retried.code, 0, retried.err);
  const finalShots = medium(retried).shots.map((id) => retried.state.shots[id]);
  assert.deepEqual(finalShots.map((shot) => [shot.checksum, shot.state]), [[md5(png(1206, 2622, { shade: 10 })), "COMPLETE"], [md5(png(1206, 2622, { shade: 77 })), "COMPLETE"]]);
  assert.equal(medium(retried).shots[0], before[0], "the screenshot that already matched is kept, never uploaded again");
  assert.equal(retried.steps.filter((step) => step === "POST /v1/appScreenshots").length, 1);
});

test("round 5: replacing a full set of ten makes room one at a time and never empties it", () => {
  const ten = Array.from({ length: 10 }, (_, at) => png(1206, 2622, { shade: 100 + at }));
  const first = listingRun(listingState(), { store: storeDir({ medium: ten }) });
  assert.equal(first.code, 0, first.err);
  const next = Array.from({ length: 10 }, (_, at) => png(1206, 2622, { shade: at < 8 ? 100 + at : 150 + at }));
  const run = listingRun(first.stateFile, { store: storeDir({ medium: next }) });
  assert.equal(run.code, 0, run.err);
  assert.equal(run.steps.filter((step) => step === "POST /v1/appScreenshots").length, 2);
  assert.equal(run.steps.filter((step) => step.startsWith("DELETE")).length, 2);
  const set = run.state.sets.find((entry) => entry.type === "APP_IPHONE_61");
  assert.deepEqual(set.shots.map((id) => run.state.shots[id].checksum), next.map(md5));
});

test("round 5: a PNG that only has a header, a truncated one or one with a bad checksum is refused", () => {
  const good = png(1206, 2622, { shade: 5 });
  const headerOnly = good.subarray(0, 33);
  const truncated = good.subarray(0, good.length - 40);
  const badCrc = Buffer.from(good);
  badCrc[29] ^= 0xff;
  const run = listingRun(listingState(), { store: storeDir({ medium: [headerOnly, truncated, badCrc] }), extra: ["--check"], key: false });
  assert.equal(run.code, 1, run.out);
  for (const name of ["01-shot.png", "02-shot.png", "03-shot.png"]) assert.match(run.err, new RegExp(`${name.replace(".", "\\.")} isn't a complete PNG`));
  assert.deepEqual(run.requests, []);
});

test("round 5: an App Review error never prints Apple's words, which can carry the contact", () => {
  const run = listingRun(listingState({ reviewError: "15550100100" }));
  assert.equal(run.code, 1, run.out);
  assert.doesNotMatch(run.out + run.err, /15550100100|Phone must be/);
  assert.match(run.err, /422/);
  assert.match(run.err, /ENTITY_ERROR\.ATTRIBUTE\.INVALID at \/data\/attributes\/contactPhone/);
});

test("round 5: listing counts keywords and review notes in UTF-8 bytes, type-checks listing.json and refuses null, all before any request", () => {
  const bytes = listingRun(listingState(), { store: storeDir({ text: { "keywords.txt": "é".repeat(51), "review-notes.txt": "é".repeat(2001) } }) });
  assert.equal(bytes.code, 1, bytes.out);
  assert.match(bytes.err, /keywords\.txt has 102 bytes; the keywords take at most 100/);
  assert.match(bytes.err, /review-notes\.txt has 4002 bytes; App Review notes take at most 4000/);
  assert.deepEqual(bytes.requests, []);
  const typed = listingRun(listingState(), {
    store: storeDir({ listing: { supportUrl: ["https://example.com/support"], ageRating: { advertising: "NONE", violenceRealistic: true, ageRatingOverrideV2: "SEVENTEEN_PLUS", lootBox: null }, copyright: "© 2026 Example" } }),
  });
  assert.equal(typed.code, 1, typed.out);
  for (const problem of [/supportUrl must be an https URL/, /ageRating\.advertising must be true or false/, /ageRating\.violenceRealistic must be one of NONE/, /ageRating\.ageRatingOverrideV2 must be one of NONE, NINE_PLUS, THIRTEEN_PLUS, SIXTEEN_PLUS, EIGHTEEN_PLUS, UNRATED/, /ageRating\.lootBox must be true or false/, /copyright must be the year and the holder/]) {
    assert.match(typed.err, problem);
  }
  assert.deepEqual(typed.requests, []);
  const store = storeDir();
  writeFileSync(join(store, "listing.json"), "null");
  for (const run of [listingRun(listingState(), { store }), listingRun(listingState(), { store, extra: ["--check"], key: false })]) {
    assert.equal(run.code, 1, run.out);
    assert.match(run.err, /listing\.json must hold one JSON object/);
    assert.deepEqual(run.requests, []);
  }
  const fine = listingRun(listingState(), { store: storeDir({ text: { "keywords.txt": "é".repeat(50) }, listing: { ageRating: { ageRatingOverrideV2: "EIGHTEEN_PLUS", violenceRealistic: "NONE" } } }), extra: ["--check"], key: false });
  assert.equal(fine.code, 0, fine.err);
});

test("round 5: listing leaves a secondary category alone when listing.json names none", () => {
  const store = storeDir();
  const listing = JSON.parse(readFileSync(join(store, "listing.json"), "utf8"));
  delete listing.secondaryCategory;
  writeFileSync(join(store, "listing.json"), JSON.stringify(listing));
  const run = listingRun(listingState({ appInfos: [{ id: "info", state: "PREPARE_FOR_SUBMISSION", primaryCategory: "UTILITIES", secondaryCategory: "PRODUCTIVITY" }] }), { store });
  assert.equal(run.code, 0, run.err);
  assert.ok(!run.steps.includes("PATCH /v1/appInfos/info"), run.steps.join("\n"));
  assert.equal(run.state.appInfos[0].secondaryCategory, "PRODUCTIVITY");
});

test("round 5: listing refuses a --version other than the pin, and the workflow passes the input on", () => {
  const run = listingRun(listingState(), { extra: ["--version", "1.0.2"] });
  assert.equal(run.code, 1, run.out);
  assert.match(run.err, /--version 1\.0\.2 isn't the pinned iPhone version 1\.0\.1/);
  assert.deepEqual(run.requests, []);
  const same = listingRun(listingState(), { extra: ["--version", "1.0.1", "--check"], key: false });
  assert.equal(same.code, 0, same.err);
  const workflow = readFileSync(fileURLToPath(new URL("../../../.github/workflows/ios-release.yml", import.meta.url)), "utf8");
  const job = workflow.split("\n  listing:\n")[1].split(/\n  [a-z-]+:\n/)[0];
  assert.match(job, /VERSION_INPUT: \$\{\{ inputs\.version \}\}/);
  assert.match(job, /\[ -z "\$VERSION_INPUT" \] \|\| args\+=\(--version "\$VERSION_INPUT"\)/);
});

test("round 5: every job that decodes a key removes it on exit, with the trap set before the decode", () => {
  const workflow = readFileSync(fileURLToPath(new URL("../../../.github/workflows/ios-release.yml", import.meta.url)), "utf8");
  const decodes = [...workflow.matchAll(/^( +)\(umask 077 && printf '%s' "\$ASC_KEY_P8" \| base64 -d > "\$key"\)$/gm)];
  assert.ok(decodes.length >= 6, `${decodes.length} decodes`);
  for (const decode of decodes) {
    const before = workflow.slice(Math.max(0, decode.index - 200), decode.index);
    assert.match(before, /trap 'rm -f "\$key"' EXIT\n$/, `the trap comes right before the decode at ${decode.index}`);
  }
  assert.doesNotMatch(workflow, /base64 -d > "\$key"\)\n +trap/);
});

test("round 5: a free price that starts in the future isn't the price now", () => {
  const run = listingRun(listingState({ price: { base: "USA", point: "point-free", start: "2099-01-01" } }));
  assert.equal(run.code, 0, run.err);
  assert.ok(run.steps.includes("POST /v1/appPriceSchedules"), run.steps.join("\n"));
  const ended = listingRun(listingState({ price: { base: "USA", point: "point-free", start: "2020-01-01", end: "2021-01-01" } }));
  assert.ok(ended.steps.includes("POST /v1/appPriceSchedules"), ended.steps.join("\n"));
  const now = listingRun(listingState({ price: { base: "USA", point: "point-free", start: "2020-01-01" } }));
  assert.ok(!now.steps.includes("POST /v1/appPriceSchedules"), now.steps.join("\n"));
});

test("round 5: the pinned version and the first iPhone-only build are each one plain line, read by one parser", () => {
  const read = (version, firstBuild = "1\n") => {
    const ios = fakeIosDir("1");
    writeFileSync(join(ios, "Config", "release-version"), version);
    writeFileSync(join(ios, "Config", "first-iphone-only-build"), firstBuild);
    return spawnSync(process.execPath, [script, "version", "--ios-dir", ios], { encoding: "utf8" });
  };
  for (const good of ["1.0.1\n", "1.0.1"]) {
    const run = read(good);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "1.0.1\n");
  }
  for (const bad of ["1.0.\n1\n", "1.0.1\n\n", " 1.0.1\n", "1.0.1 \n", "1.0\n", "v1.0.1\n"]) {
    const run = read(bad);
    assert.notEqual(run.status, 0, JSON.stringify(bad));
    assert.match(run.stderr, /release-version must hold one line with the version as x\.y\.z/);
  }
  const badBuild = read("1.0.1\n", "2\n2\n");
  assert.notEqual(badBuild.status, 0);
  assert.match(badBuild.stderr, /first-iphone-only-build must hold one line with a build number/);
  const first = spawnSync(process.execPath, [script, "version", "--first-build"], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^[1-9]\d*\n$/);
});

test("round 5: app-store's wait for a processing build never reads past --timeout", () => {
  const processing = (states, timeout) =>
    appStore(appStoreState({ clock: true, builds: [{ id: "b12", number: "12", version: "1.0.1", processing: states }], versions: [shippedBefore], localizations: { "made-1": [{ id: "loc", ...listing }] } }), ["--timeout", timeout]);
  const short = processing(["PROCESSING", "VALID"], "1");
  assert.equal(short.code, 1, short.out);
  assert.match(short.err, /build 12 of 1\.0\.1 is PROCESSING after 1 s/);
  assert.deepEqual(short.writes, []);
  const edge = processing(["PROCESSING", "PROCESSING", "VALID"], "40");
  assert.equal(edge.code, 1, edge.out);
  assert.deepEqual(edge.writes, []);
  const enough = processing(["PROCESSING", "PROCESSING", "VALID"], "61");
  assert.equal(enough.code, 0, enough.err);
  const now = appStore(appStoreState({ versions: [shippedBefore], localizations: { "made-1": [{ id: "loc", ...listing }] } }), ["--timeout", "0"]);
  assert.equal(now.code, 0, now.err);
});

test("round 5: listing refuses a project whose device family it can't read", () => {
  for (const extra of [[], ["--check"]]) {
    const run = listingRun(listingState(), { ios: fakeIosDir(null), extra, key: extra.length === 0 });
    assert.equal(run.code, 1, run.out);
    assert.match(run.err, /TARGETED_DEVICE_FAMILY/);
    assert.deepEqual(run.requests, []);
  }
});

test("round 5: blank promotional text or subtitle and a dropped marketingUrl clear what App Store Connect holds", () => {
  const first = listingRun(listingState());
  assert.equal(first.code, 0, first.err);
  const store = storeDir({ text: { "promotional-text.txt": "", "subtitle.txt": "\n" } });
  const listing = JSON.parse(readFileSync(join(store, "listing.json"), "utf8"));
  delete listing.marketingUrl;
  writeFileSync(join(store, "listing.json"), JSON.stringify(listing));
  const cleared = listingRun(first.stateFile, { store });
  assert.equal(cleared.code, 0, cleared.err);
  const version = cleared.writes.find((write) => write.path.startsWith("/v1/appStoreVersionLocalizations/"));
  assert.deepEqual(version.body.data.attributes, { promotionalText: null, marketingUrl: null });
  const info = cleared.writes.find((write) => write.path.startsWith("/v1/appInfoLocalizations/"));
  assert.deepEqual(info.body.data.attributes, { subtitle: null });
  const again = listingRun(cleared.stateFile, { store });
  assert.deepEqual(again.writes, []);
  const fresh = listingRun(listingState(), { store });
  assert.equal(fresh.code, 0, fresh.err);
  const made = fresh.writes.find((write) => write.path === "/v1/appStoreVersionLocalizations");
  assert.ok(!("promotionalText" in made.body.data.attributes) && !("marketingUrl" in made.body.data.attributes), JSON.stringify(made.body.data.attributes));
});

test("round 6: at the ten-screenshot cap, each replacement finishes processing before the next original goes", () => {
  const ten = Array.from({ length: 10 }, (_, at) => png(1206, 2622, { shade: 100 + at }));
  const first = listingRun(listingState(), { store: storeDir({ medium: ten }) });
  assert.equal(first.code, 0, first.err);
  const originals = first.state.sets.find((set) => set.type === "APP_IPHONE_61").shots;
  const failing = JSON.parse(readFileSync(first.stateFile, "utf8"));
  failing.failProcessing = 1;
  writeFileSync(first.stateFile, JSON.stringify(failing));
  const next = Array.from({ length: 10 }, (_, at) => png(1206, 2622, { shade: 200 + at }));
  const run = listingRun(first.stateFile, { store: storeDir({ medium: next }) });
  assert.equal(run.code, 1, run.out);
  assert.match(run.err, /refused screenshot 01-shot\.png/);
  const left = originals.filter((id) => run.state.shots[id]?.state === "COMPLETE");
  assert.equal(left.length, 9, `${left.length} originals left`);
  assert.equal(run.steps.filter((step) => step === "POST /v1/appScreenshots").length, 1);
  const retried = listingRun(first.stateFile, { store: storeDir({ medium: next }) });
  assert.equal(retried.code, 0, retried.err);
  const set = retried.state.sets.find((entry) => entry.type === "APP_IPHONE_61");
  assert.deepEqual(set.shots.map((id) => retried.state.shots[id].checksum), next.map(md5));
});

test("round 6: a finished screenshot with no checksum is held until its replacements settle", () => {
  const first = listingRun(listingState(), { store: storeDir() });
  assert.equal(first.code, 0, first.err);
  const unknown = JSON.parse(readFileSync(first.stateFile, "utf8"));
  const medium = unknown.sets.find((set) => set.type === "APP_IPHONE_61");
  for (const id of medium.shots) delete unknown.shots[id].checksum;
  unknown.failUploads = 1;
  writeFileSync(first.stateFile, JSON.stringify(unknown));
  const failed = listingRun(first.stateFile, { store: storeDir() });
  assert.equal(failed.code, 1, failed.out);
  assert.ok(!failed.steps.some((step) => step.startsWith("DELETE")), failed.steps.join("\n"));
  for (const id of medium.shots) assert.equal(failed.state.shots[id].state, "COMPLETE");
  const retried = listingRun(first.stateFile, { store: storeDir() });
  assert.equal(retried.code, 0, retried.err);
  const after = retried.state.sets.find((set) => set.type === "APP_IPHONE_61").shots;
  assert.ok(medium.shots.every((id) => !after.includes(id)), "the unmatched ones go once their replacements are in");
  assert.equal(after.length, 2);
  const lastDelete = Math.max(...retried.steps.map((step, at) => (step.startsWith("DELETE") ? at : -1)));
  const lastUpload = Math.max(...retried.steps.map((step, at) => (step === "POST /v1/appScreenshots" ? at : -1)));
  assert.ok(lastDelete > lastUpload, "deleted after the uploads");
});

test("round 6: a PNG whose scanlines use an unknown filter type is refused before any request", () => {
  const run = listingRun(listingState(), { store: storeDir({ medium: [png(1206, 2622, { shade: 9, filter: 5 })] }), extra: ["--check"], key: false });
  assert.equal(run.code, 1, run.out);
  assert.match(run.err, /01-shot\.png isn't a complete PNG: [^\n]*filter type 5/);
  assert.deepEqual(run.requests, []);
  for (const filter of [1, 2, 3, 4]) {
    const fine = listingRun(listingState(), { store: storeDir({ medium: [png(1206, 2622, { shade: 9, filter })] }), extra: ["--check"], key: false });
    assert.equal(fine.code, 0, `filter ${filter}: ${fine.err}`);
  }
});

test("round 6: a version app-store makes copies the newest copyright by full timestamp, and trusts the copyright Apple returns", () => {
  const sameDay = [
    { id: "v099", version: "0.9.9", state: "READY_FOR_SALE", build: "b9", copyright: "2026 Older", created: "2026-11-20T01:00:00Z" },
    { id: "v100", version: "1.0.0", state: "READY_FOR_SALE", build: "b9", copyright: "2026 Newer", created: "2026-11-20T20:00:00Z" },
  ];
  const run = appStore(appStoreState({ versions: sameDay, localizations: { "made-1": [{ id: "loc", ...listing }] } }));
  assert.equal(run.code, 0, run.err);
  assert.equal(run.writes[0].body.data.attributes.copyright, "2026 Newer");
  const filled = appStore(appStoreState({ copyrightOnCreate: "2026 Filled", localizations: { "made-1": [{ id: "loc", ...listing }] } }));
  assert.equal(filled.code, 0, filled.err);
  assert.ok(!("copyright" in filled.writes[0].body.data.attributes));
  assert.ok(filled.steps.some((step) => /^PATCH \/v1\/reviewSubmissions\//.test(step)), filled.steps.join("\n"));
});

test("round 6: a retried build lookup never runs past --timeout", () => {
  const ready = { clock: true, buildFailures: 1, versions: [shippedBefore], localizations: { "made-1": [{ id: "loc", ...listing }] } };
  const late = appStore(appStoreState(ready), ["--timeout", "0.5"]);
  assert.equal(late.code, 1, late.out);
  assert.ok(!late.steps.some((step) => step.startsWith("PATCH /v1/reviewSubmissions/")), late.steps.join("\n"));
  assert.deepEqual(late.writes, []);
  const roomy = appStore(appStoreState(ready), ["--timeout", "30"]);
  assert.equal(roomy.code, 0, roomy.err);
});
