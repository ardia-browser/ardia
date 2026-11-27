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

const signUpForm = ({ maxlength, pattern } = {}) => {
  const limit = (maxlength ? ` maxlength="${maxlength}"` : "") + (pattern ? ` pattern="${pattern}"` : "");
  return `<form method="post" action="/signed-in">
<input id="u" name="username" autocomplete="username" style="top:40px">
<input id="p" name="new-password" type="password" autocomplete="new-password"${limit} style="top:100px">
<input id="c" name="confirm-password" type="password" autocomplete="new-password"${limit} style="top:160px">
<button id="go" disabled style="top:220px">Create account</button></form>`;
};

const changePasswordForm = () => `<form method="post" action="/signed-in">
<input id="u" name="username" autocomplete="username" value="rotate@save.test" style="top:40px">
<input id="o" name="current-password" type="password" autocomplete="current-password" style="top:100px">
<input id="p" name="new-password" type="password" autocomplete="new-password" style="top:160px">
<input id="c" name="confirm-password" type="password" autocomplete="new-password" style="top:220px">
<button id="go" disabled style="top:280px">Change password</button></form>`;

const cardForm = () => `<form method="post" action="/signed-in">
<input id="n" name="cc-name" autocomplete="cc-name" style="top:40px">
<input id="num" name="cc-number" autocomplete="cc-number" style="top:100px">
<input id="m" name="cc-exp-month" autocomplete="cc-exp-month" style="top:160px">
<input id="y" name="cc-exp-year" autocomplete="cc-exp-year" style="top:220px">
<button id="go" style="top:280px">Pay</button></form>`;

const holdSubmit = `
document.addEventListener("submit", (e) => {
  e.preventDefault();
  note(["submit", e.target.id]);
});`;

const enableWhenFilled = `
const go = document.getElementById("go");
const ready = () => (go.disabled = !(document.getElementById("u").value && document.getElementById("p").value));
document.addEventListener("input", ready, true);`;

const emailSignInForm = () => `<form method="post" action="/signed-in">
<input id="u" name="email" type="email" autocomplete="username" style="top:40px">
<input id="p" name="password" type="password" autocomplete="current-password" style="top:100px">
<button id="go" disabled style="top:160px">Sign in</button></form>`;

const emailSignUpForm = () => `<form method="post" action="/signed-in">
<input id="u" name="email" type="email" autocomplete="email" style="top:40px">
<input id="p" name="new-password" type="password" autocomplete="new-password" style="top:100px">
<input id="c" name="confirm-password" type="password" autocomplete="new-password" style="top:160px">
<button id="go" disabled style="top:220px">Create account</button></form>`;

const checkoutForm = () => `<form method="post" action="/signed-in">
<input id="name" name="name" autocomplete="name" style="top:40px">
<input id="u" name="email" type="email" autocomplete="email" style="top:100px">
<input id="street" name="street" autocomplete="street-address" style="top:160px">
<input id="city" name="city" autocomplete="address-level2" style="top:220px">
<input id="zip" name="zip" autocomplete="postal-code" style="top:280px">
<button id="go" style="top:340px">Pay</button></form>`;

const identifierForm = ({ autocomplete, button }) => `<form method="post" action="/signed-in">
<input id="u" name="identifier" type="email"${autocomplete ? ` autocomplete="${autocomplete}"` : ""} style="top:40px">
<button id="go" style="top:100px">${button}</button></form>`;

export const PAGES = {
  "/identifier": (host) => page(`Sign in to ${host}`, identifierForm({ autocomplete: "username webauthn", button: "Next" })),
  "/identifier-next": (host) => page(`Sign in to ${host}`, identifierForm({ button: "Continue" })),
  "/login-email": (host) => page(`Sign in to ${host}`, emailSignInForm(), enableWhenFilled),
  "/signup-email": (host) => page(`Sign up on ${host}`, emailSignUpForm(), enableWhenFilled),
  "/checkout": (host) => page(`Check out on ${host}`, checkoutForm()),
  "/login": (host) => page(`Sign in to ${host}`, loginForm(), enableWhenFilled),
  "/login-claims-parent": (host) =>
    page(`Sign in to ${host}`, loginForm(), `${enableWhenFilled}
const fake = { getBoundingClientRect: () => ({ left: 20, top: 20, width: 420, height: 240 }), clientLeft: 0, clientTop: 0 };
Object.defineProperty(window, "frameElement", { get: () => fake, configurable: true });`),
  "/login-ready": (host) => page(`Sign in to ${host}`, loginForm("/signed-in", { ready: true }), holdSubmit),
  "/login-fails": (host) => page(`Sign in to ${host}`, loginForm("/login-fails"), enableWhenFilled),
  "/signup": (host) => page(`Sign up on ${host}`, signUpForm(), enableWhenFilled),
  "/signup-short": (host) => page(`Sign up on ${host}`, signUpForm({ maxlength: 12 }), enableWhenFilled),
  "/signup-pattern": (host) => page(`Sign up on ${host}`, signUpForm({ pattern: "[A-Za-z0-9]{8,}" }), enableWhenFilled),
  "/change-password": (host) => page(`Change password on ${host}`, changePasswordForm(), enableWhenFilled),
  "/card": (host) => page(`Pay on ${host}`, cardForm()),
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
  const otherPortUrl = (host, pathname = "/login") => `https://${host}:${ports.otherSecure}${pathname}`;
  const url = (host, pathname = "/login") => `${PLAIN_HOSTS.includes(host) ? "http" : "https"}://${host}:${PLAIN_HOSTS.includes(host) ? ports.plain : ports.secure}${pathname}`;
  const answer = (req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const asked = new URL(req.url, "http://x");
    const route = pages[asked.pathname];
    seen.push({ host, url: req.url, method: req.method });
    res.writeHead(route ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    const framePath = asked.searchParams.get("framePath") ?? "/login";
    const frameHost = asked.searchParams.get("frame") ?? "other.localhost";
    res.end(route ? route(host, { frame: asked.searchParams.get("framePort") === "other" ? otherPortUrl(frameHost, framePath) : url(frameHost, framePath) }) : "not found");
  };
  const pem = fs.readFileSync(cert);
  const secure = createHttpsServer({ key: fs.readFileSync(key), cert: pem }, answer);
  const plain = createServer(answer);
  const otherSecure = createHttpsServer({ key: fs.readFileSync(key), cert: pem }, answer);
  [ports.secure, ports.plain, ports.otherSecure] = [await listen(secure), await listen(plain), await listen(otherSecure)];
  const spki = createHash("sha256").update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  return {
    seen,
    switches: `--ignore-certificate-errors-spki-list=${spki}`,
    url,
    secureUrl: (host, pathname = "/login") => `https://${host}:${ports.secure}${pathname}`,
    origin: (host) => new URL(url(host)).origin,
    otherPortUrl,
    close: () => Promise.all([secure, plain, otherSecure].map((s) => new Promise((r) => s.close(r)))),
  };
}
