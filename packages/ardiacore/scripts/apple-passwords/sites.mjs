import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";

export const SECURE_HOSTS = ["example.test", "accounts.example.test", "other.test"];
export const PLAIN_HOSTS = ["plain.test"];

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body>${body}<script>
window.__events = [];
for (const type of ["input", "change"]) document.addEventListener(type, (e) => window.__events.push([type, e.target.id]), true);
</script></body>`;

export const PAGES = {
  "/login": (host) =>
    page(`Sign in to ${host}`, `<form method="post" action="/signed-in"><input id="u" name="username" autocomplete="username"><input id="p" name="password" type="password" autocomplete="current-password"><button id="go">Sign in</button></form>`),
  "/signed-in": (host) => page(`Signed in to ${host}`, "<p>Welcome</p>"),
};

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

export async function fixtureSites(dir, pages = PAGES) {
  fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  if (!fs.existsSync(cert)) {
    const names = SECURE_HOSTS.map((h) => `DNS:${h}`).join(",");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=example.test", "-addext", `subjectAltName=${names}`, "-keyout", key, "-out", cert], { stdio: "ignore" });
  }
  const seen = [];
  const answer = (req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const route = pages[new URL(req.url, "http://x").pathname];
    seen.push({ host, url: req.url, method: req.method });
    res.writeHead(route ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(route ? route(host) : "not found");
  };
  const pem = fs.readFileSync(cert);
  const secure = createHttpsServer({ key: fs.readFileSync(key), cert: pem }, answer);
  const plain = createServer(answer);
  const [securePort, plainPort] = [await listen(secure), await listen(plain)];
  const spki = createHash("sha256").update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  const rules = [...SECURE_HOSTS.map((h) => `MAP ${h} 127.0.0.1:${securePort}`), ...PLAIN_HOSTS.map((h) => `MAP ${h} 127.0.0.1:${plainPort}`)].join(", ");
  return {
    seen,
    switches: `--host-resolver-rules=${rules} --ignore-certificate-errors-spki-list=${spki}`,
    url: (host, pathname = "/login") => `${PLAIN_HOSTS.includes(host) ? "http" : "https"}://${host}${pathname}`,
    close: () => Promise.all([secure, plain].map((s) => new Promise((r) => s.close(r)))),
  };
}
