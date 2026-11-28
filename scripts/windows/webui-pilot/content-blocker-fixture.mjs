import { createServer } from "node:http";

const AD_SLOTS = ["#ad_banner", ".ad-slot", ".sponsored-ad"];
const CONTENT_SLOT = "#article";
const AD_SCRIPT = "/banner_ads/ad.js";
const CONTENT_SCRIPT = "/scripts/app.js";
const THIRD_PARTY_AD = "https://ad.doubleclick.net/ddm/adj/ardia-check.js";
const SETTLE_MS = 15000;
const HOST = "ardia-check.test";

const slot = (selector) => {
  const attribute = selector.startsWith("#") ? `id="${selector.slice(1)}"` : `class="slot ${selector.slice(1)}"`;
  return `<div ${attribute} data-ad-slot><b>AD</b><code>${selector}</code></div>`;
};

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Ardia ad-block check</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 32px; color: #1d1d1f; background: #fafafa; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  p { margin: 0 0 20px; color: #555; }
  .row { display: flex; gap: 16px; margin-bottom: 24px; }
  [data-ad-slot], ${CONTENT_SLOT} { width: 200px; height: 104px; border-radius: 8px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; }
  [data-ad-slot] { border: 2px dashed #c0392b; background: repeating-linear-gradient(45deg, #fdecea 0 10px, #f9d6d2 10px 20px); color: #922b21; }
  ${CONTENT_SLOT} { border: 2px solid #2471a3; background: #eaf2f8; color: #1a5276; }
  code, td { font-family: ui-monospace, monospace; font-size: 14px; }
  table { border-collapse: collapse; }
  td, th { text-align: left; padding: 6px 14px 6px 0; border-bottom: 1px solid #ddd; }
  .loaded { color: #922b21; font-weight: 600; }
  .blocked { color: #1e8449; font-weight: 600; }
  td.blocked::before { content: "✓ "; }
  td.loaded::before { content: "✗ "; }
  #summary { font-size: 18px; font-weight: 600; margin: 0 0 16px; }
</style>
</head>
<body>
<h1>Ardia ad-block check</h1>
<p>Red boxes are fake ads named the way EasyList's rules name real ones. The blue box is ordinary content and should always show.</p>
<div class="row">${AD_SLOTS.map(slot).join("")}<div id="${CONTENT_SLOT.slice(1)}"><b>Content</b><code>${CONTENT_SLOT}</code></div></div>
<div id="summary">Checking…</div>
<table><thead><tr><th>Request</th><th>Result</th></tr></thead><tbody id="requests"></tbody></table>
<script>
  const adRequests = ${JSON.stringify([AD_SCRIPT, THIRD_PARTY_AD])};
  const contentRequest = ${JSON.stringify(CONTENT_SCRIPT)};
  const body = document.getElementById("requests");
  const cells = new Map();
  const network = {};
  const row = (url) => {
    const line = body.insertRow();
    line.insertCell().textContent = url;
    const cell = line.insertCell();
    cell.textContent = "…";
    cells.set(url, cell);
  };
  const script = (url) => new Promise((resolve) => {
    row(url);
    const element = document.createElement("script");
    element.src = url;
    element.onload = () => resolve(network[url] = true);
    element.onerror = () => resolve(network[url] = false);
    document.head.appendChild(element);
  });
  const shown = (element) => !!element && getComputedStyle(element).display !== "none" && element.getClientRects().length > 0;
  const measure = (settled) => {
    const ads = [...document.querySelectorAll("[data-ad-slot]")];
    for (const [url, went] of Object.entries(network)) {
      const cell = cells.get(url);
      cell.textContent = went ? "loaded" : "blocked";
      cell.className = went === (url === contentRequest) ? "blocked" : "loaded";
    }
    const result = {
      hiddenAds: ads.filter((ad) => !shown(ad)).length,
      ads: ads.length,
      contentShown: shown(document.querySelector(${JSON.stringify(CONTENT_SLOT)})),
      reached: { ...network },
      settled,
    };
    const blocked = adRequests.filter((url) => !network[url]).length;
    document.getElementById("summary").textContent = "Ads hidden: " + result.hiddenAds + " of " + result.ads + " · Ad requests blocked: " + blocked + " of " + adRequests.length;
    window.adCheck = result;
    return result;
  };
  Promise.all([...adRequests, contentRequest].map(script)).then(() => {
    const started = Date.now();
    const tick = () => {
      const result = measure(false);
      if (result.hiddenAds === result.ads || Date.now() - started >= ${SETTLE_MS}) return measure(true);
      setTimeout(tick, 250);
    };
    tick();
  });
</script>
</body>
</html>`;

const hits = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return response.end(PAGE);
  }
  if (url.pathname === "/hits") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return response.end(JSON.stringify(hits));
  }
  if (url.pathname === AD_SCRIPT || url.pathname === CONTENT_SCRIPT) {
    hits.push(url.pathname);
    response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
    return response.end("void 0;");
  }
  response.writeHead(404);
  response.end();
});
server.listen(Number(process.argv[2] ?? 0), "127.0.0.1", () => {
  const { port } = server.address();
  console.log(JSON.stringify({
    served: `http://127.0.0.1:${port}/`,
    page: `http://${HOST}:${port}/`,
    hostRule: `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
    adScript: AD_SCRIPT,
    contentScript: CONTENT_SCRIPT,
    thirdPartyAd: THIRD_PARTY_AD,
  }));
});
