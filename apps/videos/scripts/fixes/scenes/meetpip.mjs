import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "../../capture/sites/huddle.example");
const scratch = process.env.FIXES_SCRATCH ?? join(process.env.HOME, "ardia-scratch/video-fixes");
const sitesPort = Number(process.env.FIXES_SITES_PORT ?? 47231);
const callPort = Number(process.env.FIXES_CALL_PORT ?? 47232);
const certs = join(scratch, "call-cert");

if (!existsSync(join(certs, "cert.pem"))) {
  mkdirSync(certs, { recursive: true });
  writeFileSync(join(certs, "openssl.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=huddle.example\n[ext]\nsubjectAltName=DNS:huddle.example\n");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "7", "-keyout", join(certs, "key.pem"), "-out", join(certs, "cert.pem"), "-config", join(certs, "openssl.cnf")], { stdio: "ignore" });
}

const spki = execFileSync("sh", ["-c", `openssl x509 -in "${join(certs, "cert.pem")}" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`]).toString().trim();
const types = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml" };
const server = createServer({ key: readFileSync(join(certs, "key.pem")), cert: readFileSync(join(certs, "cert.pem")) }, (req, res) => {
  const path = new URL(req.url, "https://huddle.example").pathname;
  const file = join(site, path === "/" ? "index.html" : path.slice(1));
  if (!file.startsWith(site) || !existsSync(file)) {
    res.writeHead(404);
    return res.end("not found");
  }
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
});
await new Promise((resolve, reject) => server.once("error", reject).listen(callPort, "127.0.0.1", resolve));
server.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
    const got = await fn();
    if (got) return got;
  }
  throw new Error(`timed out waiting for ${what}`);
};

async function grantCamera(instance) {
  const page = await instance.page("huddle.example", { timeout: 20000 });
  const asked = page.eval(`navigator.mediaDevices.getUserMedia({ video: true }).then((s) => (s.getTracks().forEach((t) => t.stop()), "granted"), (e) => e.name)`, { userGesture: true, timeout: 20000 });
  const prompt = await until("the camera prompt", async () => JSON.parse(await instance.eval(`return JSON.stringify(ac.pageState.getState().pages.call?.permission ?? null)`)), 15000);
  await instance.eval(`ac.permissions.answerPermission("call", ${JSON.stringify(prompt.id)}, "accept"); return "ok"`);
  const answer = await asked;
  page.close();
  if (answer !== "granted") throw new Error(`camera: ${answer}`);
  return { prompt: prompt.kind ?? prompt.type ?? Object.keys(prompt), answer };
}

async function watchCall(instance, ms) {
  const page = await instance.page("huddle.example");
  const events = [];
  let last = null;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const s = await page.eval(`JSON.stringify(state())`).then(JSON.parse, () => null);
    const now = s && JSON.stringify({ open: s.open, visibility: s.visibility, asked: s.asked, joined: s.joined });
    if (now && now !== last) {
      events.push({ t: Date.now(), call: { open: s.open, visibility: s.visibility, asked: s.asked.length, lastAsked: s.asked.at(-1) ?? null, joined: s.joined } });
      last = now;
    }
  }
  page.close();
  return events;
}

export default {
  session: "session-meet-auto-pip.json",
  switches: [`--ignore-certificate-errors-spki-list=${spki}`, `--host-resolver-rules=MAP huddle.example 127.0.0.1:${callPort}, MAP *.example 127.0.0.1:${sitesPort}`],
  test: { systemMediaPermission: "ask" },
  dylibs: ["reveal-pip"],
  setup: `st().activate("news"); return sleep(2000).then(() => { st().activate("call"); return sleep(2500); }).then(() => done());`,
  prepare: grantCamera,
  external: (instance) => watchCall(instance, 15000),
  act: `const JOIN = [1136, 540];
const NEWS = [140, 122];
const CALL = [112, 85];
return at(760, 760).then(() => sleep(500))
  .then(() => move(JOIN[0], JOIN[1], 750)).then(() => sleep(250))
  .then(() => { mark("join"); return click(); }).then(() => sleep(2200))
  .then(() => move(NEWS[0], NEWS[1], 850)).then(() => sleep(300))
  .then(() => { mark("go"); return click(); }).then(() => sleep(350))
  .then(() => move(640, 660, 700)).then(() => sleep(3600))
  .then(() => move(CALL[0], CALL[1], 850)).then(() => sleep(300))
  .then(() => { mark("back"); return click(); }).then(() => sleep(400))
  .then(() => move(700, 760, 700)).then(() => sleep(1800))
  .then(() => done({ tab: st().windows[W].activeTabIds.default }));`,
  tail: 600,
};
