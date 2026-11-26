import { renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [readyFile, resultFile] = process.argv.slice(2);
if (!readyFile || !resultFile) process.exit(2);

const target = createServer((req, res) => {
  if (req.url && req.url.startsWith("/secret")) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("ardia-cors-secret");
    return;
  }
  res.writeHead(404);
  res.end();
});

let targetPort = 0;

const origin = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/probe") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(
      `<!doctype html><title>cors probe</title><script>fetch("http://127.0.0.1:${targetPort}/secret").then((r) => r.text()).then((t) => fetch("/result?state=" + encodeURIComponent(t === "ardia-cors-secret" ? "leaked" : "unexpected"))).catch(() => fetch("/result?state=blocked"));</script>`,
    );
    return;
  }
  if (url.pathname === "/result") {
    const state = url.searchParams.get("state") || "empty";
    const tmp = `${resultFile}.tmp`;
    writeFileSync(tmp, state, "utf8");
    renameSync(tmp, resultFile);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

target.listen(0, "127.0.0.1", () => {
  targetPort = target.address().port;
  origin.listen(0, "127.0.0.1", () => {
    const originPort = origin.address().port;
    const tmp = `${readyFile}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ originPort, targetPort, probeUrl: `http://127.0.0.1:${originPort}/probe` }),
      "utf8",
    );
    renameSync(tmp, readyFile);
  });
});
