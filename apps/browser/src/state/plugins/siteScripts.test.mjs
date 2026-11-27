import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CHROMIUM_MISSING, launchChromium } from "../../../../../scripts/lib/test-chromium.mjs";

const { SITES_LIMITS } = await import("./channelSites.ts");
const { SITE_SCRIPTS } = await import("./siteScripts.ts");

const SECRET = "tok-7f3a9c";
const BIG = Buffer.alloc(5 * 1024 * 1024 + 123, 0);
for (let i = 0; i < BIG.length; i++) BIG[i] = (i * 31 + 7) & 0xff;

let dir;
let server;
let port;
let browser;
let page;
const hits = [];

function certificate() {
  dir = mkdtempSync(join(tmpdir(), "ardia-sites-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=app.example.test", "-addext", "subjectAltName=DNS:app.example.test,DNS:other.example.test", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
  return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
}

function handle(req, res) {
  const host = (req.headers.host ?? "").split(":")[0];
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    hits.push({ host, path: req.url, cookie: req.headers.cookie ?? "", authorization: req.headers.authorization ?? "", origin: req.headers.origin ?? "", method: req.method });
    if (host === "other.example.test") {
      res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
      return res.end("stolen");
    }
    if (req.url === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("User-agent: *\n");
    }
    if (req.url === "/api/echo") {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": `refreshed=${SECRET}; Secure; HttpOnly`, "x-internal": "hidden", "x-ratelimit-remaining": "9" });
      return res.end(JSON.stringify({ method: req.method, body, active: req.headers["x-notion-active-user-header"] ?? null }));
    }
    if (req.url === "/away") {
      res.writeHead(302, { location: `https://other.example.test:${port}/steal` });
      return res.end();
    }
    if (req.url === "/same") {
      res.writeHead(302, { location: "/api/echo" });
      return res.end();
    }
    if (req.url === "/large") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("x".repeat(SITES_LIMITS.replyBodyBytes + 10));
    }
    if (req.url === "/export.zip") {
      if (!(req.headers.cookie ?? "").includes(`file_token=${SECRET}`)) {
        res.writeHead(403, { "content-type": "text/plain" });
        return res.end("no");
      }
      res.writeHead(200, { "content-type": "application/zip", "content-length": String(BIG.length) });
      return res.end(BIG);
    }
    res.writeHead(404);
    res.end();
  });
}

before(async () => {
  if (CHROMIUM_MISSING) return;
  server = createServer(certificate(), handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  browser = await launchChromium({ args: ["--host-resolver-rules=MAP *.example.test 127.0.0.1", "--ignore-certificate-errors"] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([
    { name: "token_v2", value: SECRET, domain: "app.example.test", path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "file_token", value: SECRET, domain: "app.example.test", path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "theirs", value: SECRET, domain: "other.example.test", path: "/", secure: true, httpOnly: true, sameSite: "None" },
  ]);
  page = await context.newPage();
  await page.goto(`https://app.example.test:${port}/robots.txt`);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const origin = () => `https://app.example.test:${port}`;

const run = (script) =>
  page.evaluate(
    (code) =>
      new Promise((resolve) => {
        new Function("post", code)((kind, json) => resolve(JSON.parse(json)));
      }),
    script,
  );

const fetchSpec = (path, extra = {}) => ({ origin: origin(), url: `${origin()}${path}`, method: "GET", headers: {}, timeoutMs: 10_000, cap: SITES_LIMITS.replyBodyBytes, keep: SITE_SCRIPTS.keptHeaders, ...extra });

test("the request carries the site's own cookies, which the answer never shows", { skip: CHROMIUM_MISSING }, async () => {
  hits.length = 0;
  const answer = await run(SITE_SCRIPTS.fetch(fetchSpec("/api/echo", { method: "POST", body: '{"a":1}', headers: { "content-type": "application/json", "x-notion-active-user-header": "u1", cookie: "forged=1", authorization: "Bearer forged" } })));
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(answer.body), { method: "POST", body: '{"a":1}', active: "u1" });
  assert.deepEqual(Object.keys(answer.headers).sort(), ["content-type", "date", "x-ratelimit-remaining"]);
  assert.ok(!JSON.stringify(answer).includes(SECRET), "no cookie value reaches the answer");
  const hit = hits.find((h) => h.path === "/api/echo");
  assert.match(hit.cookie, new RegExp(`token_v2=${SECRET}`));
  assert.ok(!hit.cookie.includes("forged"), "the page can't add a cookie of its own");
  assert.equal(hit.origin, origin());
});

test("a redirect is refused before anything reaches the other site, and so is a same-site one", { skip: CHROMIUM_MISSING }, async () => {
  hits.length = 0;
  assert.deepEqual(await run(SITE_SCRIPTS.fetch(fetchSpec("/away"))), { error: "redirect" });
  assert.deepEqual(await run(SITE_SCRIPTS.fetch(fetchSpec("/same"))), { error: "redirect" });
  assert.equal(hits.filter((h) => h.host === "other.example.test").length, 0, "nothing was sent to the other site");
  assert.deepEqual(await run(SITE_SCRIPTS.downloadStart({ origin: origin(), url: `${origin()}/away`, headers: {}, id: "dx", timeoutMs: 10_000 })), { error: "redirect" });
  assert.equal(hits.filter((h) => h.host === "other.example.test").length, 0);
});

test("a request for another origin never leaves the page, even when asked for directly", { skip: CHROMIUM_MISSING }, async () => {
  hits.length = 0;
  const answer = await run(SITE_SCRIPTS.fetch(fetchSpec("/x", { url: `https://other.example.test:${port}/steal` })));
  assert.equal(answer.error, "network");
  assert.equal(hits.filter((h) => h.host === "other.example.test").length, 0);
  assert.deepEqual(await run(SITE_SCRIPTS.fetch({ ...fetchSpec("/api/echo"), origin: `https://other.example.test:${port}` })), { error: "origin" });
});

test("an answer over the cap is refused", { skip: CHROMIUM_MISSING }, async () => {
  assert.deepEqual(await run(SITE_SCRIPTS.fetch(fetchSpec("/large"))), { error: "too_large" });
});

test("a download streams in chunks that put the file back together exactly", { skip: CHROMIUM_MISSING }, async () => {
  const start = await run(SITE_SCRIPTS.downloadStart({ origin: origin(), url: `${origin()}/export.zip`, headers: {}, id: "d1", timeoutMs: 10_000 }));
  assert.equal(start.status, 200);
  assert.equal(start.total, BIG.length);
  const parts = [];
  for (let i = 0; i < 20; i++) {
    const step = await run(SITE_SCRIPTS.downloadNext("d1", SITES_LIMITS.chunkBytes));
    assert.equal(step.error, undefined);
    assert.ok(step.size <= SITES_LIMITS.chunkBytes);
    parts.push(Buffer.from(step.data, "base64"));
    if (step.end) break;
  }
  const whole = Buffer.concat(parts);
  assert.equal(whole.length, BIG.length);
  assert.equal(createHash("sha256").update(whole).digest("hex"), createHash("sha256").update(BIG).digest("hex"));
  assert.deepEqual(await run(SITE_SCRIPTS.downloadNext("d1", SITES_LIMITS.chunkBytes)), { error: "gone" });
});

test("a cancelled download stops and leaves nothing behind in the page", { skip: CHROMIUM_MISSING }, async () => {
  await run(SITE_SCRIPTS.downloadStart({ origin: origin(), url: `${origin()}/export.zip`, headers: {}, id: "d2", timeoutMs: 10_000 }));
  await run(SITE_SCRIPTS.downloadNext("d2", 1024));
  assert.equal(await run(SITE_SCRIPTS.downloadCancel("d2")), true);
  assert.deepEqual(await run(SITE_SCRIPTS.downloadNext("d2", 1024)), { error: "gone" });
});
