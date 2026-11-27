import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";

export const SECURE_HOSTS = ["example.localhost", "accounts.example.localhost", "other.localhost", "empty.localhost", "save.localhost", "filter.localhost"];
export const PLAIN_HOSTS = ["plain.localhost", "plain-save.localhost"];
export const PAGE_EVENTS = `JSON.parse(document.documentElement.dataset.events || "[]")`;

const recorder = `
const note = (event) => (document.documentElement.dataset.events = JSON.stringify([...JSON.parse(document.documentElement.dataset.events || "[]"), event]));
for (const type of ["input", "change", "focusin"]) document.addEventListener(type, (e) => {
  note([type, e.target.id]);
  if (parent !== window) parent.postMessage({ framed: [type, e.target.id] }, "*");
}, true);
addEventListener("message", (e) => e.data && e.data.framed && note(["framed", ...e.data.framed]));`;

const page = (title, body, script = "") => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>
body{margin:0;font:14px system-ui}input,button{position:absolute;left:40px;width:300px;height:30px;box-sizing:border-box}
</style><body>${body}<script>${recorder}${script}</script></body>`;

const loginForm = (action = "/signed-in", { ready = false } = {}) => `<form method="post" action="${action}">
<input id="u" name="username" autocomplete="username" style="top:40px">
<input id="p" name="password" type="password" autocomplete="current-password" style="top:100px">
<button id="go"${ready ? "" : " disabled"} style="top:160px">Sign in</button></form>`;

const holdSubmit = `
document.addEventListener("submit", (e) => {
  e.preventDefault();
  note(["submit", e.target.id]);
});`;

const enableWhenFilled = `
const go = document.getElementById("go");
const ready = () => (go.disabled = !(document.getElementById("u").value && document.getElementById("p").value));
document.addEventListener("input", ready, true);`;

export const PAGES = {
  "/login": (host) => page(`Sign in to ${host}`, loginForm(), enableWhenFilled),
  "/login-ready": (host) => page(`Sign in to ${host}`, loginForm("/signed-in", { ready: true }), holdSubmit),
  "/login-fails": (host) => page(`Sign in to ${host}`, loginForm("/login-fails"), enableWhenFilled),
  "/signed-in": (host) => page(`Signed in to ${host}`, "<p>Welcome</p>"),
  "/search": (host) => page(`Search ${host}`, `<form role="search" action="/signed-in"><input id="q" type="search" name="q" placeholder="Search" style="top:40px"></form>`),
  "/newsletter": (host) =>
    page(`Newsletter on ${host}`, `<form action="/signed-in"><input id="email" type="email" name="email" placeholder="Your email" style="top:40px"><button id="subscribe" style="top:100px">Subscribe</button></form>`),
  "/code": (host) =>
    page(`Verify on ${host}`, `<form method="post" action="/signed-in"><input id="c" name="otp" autocomplete="one-time-code" inputmode="numeric" style="top:40px"><button id="go" style="top:100px">Verify</button></form>`),
  "/code-filled": (host) =>
    page(`Verify on ${host}`, `<form method="post" action="/signed-in"><input id="c" name="otp" autocomplete="one-time-code" inputmode="numeric" value="12" style="top:40px"><button id="go" style="top:100px">Verify</button></form>`),
  "/framed": (host, { frame }) =>
    page(`Framed on ${host}`, `<iframe id="frame" src="${frame}" style="position:absolute;left:20px;top:20px;width:420px;height:240px;border:0"></iframe>`),
};

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

export async function fixtureSites(dir, pages = PAGES) {
  fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const names = [...SECURE_HOSTS, ...PLAIN_HOSTS].map((h) => `DNS:${h}`).join(",");
  const stamp = path.join(dir, "names.txt");
  if (!fs.existsSync(cert) || !fs.existsSync(stamp) || fs.readFileSync(stamp, "utf8") !== names) {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", `/CN=${SECURE_HOSTS[0]}`, "-addext", `subjectAltName=${names}`, "-keyout", key, "-out", cert], { stdio: "ignore" });
    fs.writeFileSync(stamp, names);
  }
  const seen = [];
  const ports = {};
  const url = (host, pathname = "/login") => `${PLAIN_HOSTS.includes(host) ? "http" : "https"}://${host}:${PLAIN_HOSTS.includes(host) ? ports.plain : ports.secure}${pathname}`;
  const answer = (req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const asked = new URL(req.url, "http://x");
    const route = pages[asked.pathname];
    seen.push({ host, url: req.url, method: req.method });
    res.writeHead(route ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(route ? route(host, { frame: url(asked.searchParams.get("frame") ?? "other.localhost", "/login") }) : "not found");
  };
  const pem = fs.readFileSync(cert);
  const secure = createHttpsServer({ key: fs.readFileSync(key), cert: pem }, answer);
  const plain = createServer(answer);
  [ports.secure, ports.plain] = [await listen(secure), await listen(plain)];
  const spki = createHash("sha256").update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  return {
    seen,
    switches: `--ignore-certificate-errors-spki-list=${spki}`,
    url,
    secureUrl: (host, pathname = "/login") => `https://${host}:${ports.secure}${pathname}`,
    origin: (host) => new URL(url(host)).origin,
    close: () => Promise.all([secure, plain].map((s) => new Promise((r) => s.close(r)))),
  };
}
