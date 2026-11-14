import type { WebContents } from "electron";
import { count } from "../counts";

type ErrorCopy = { title: string; detail: (host: string) => string; hints?: string[] };

const UNREACHABLE = "This site can’t be reached";

const COPY: Record<number, ErrorCopy> = {
  [-7]: { title: UNREACHABLE, detail: (host) => `${host} took too long to respond.`, hints: ["Checking the connection", "Checking the proxy and the firewall"] },
  [-21]: { title: "Your connection was interrupted", detail: () => "A network change was detected." },
  [-100]: { title: UNREACHABLE, detail: (host) => `${host} unexpectedly closed the connection.`, hints: ["Checking the connection", "Checking the proxy and the firewall"] },
  [-101]: { title: UNREACHABLE, detail: () => "The connection was reset.", hints: ["Checking the connection", "Checking the proxy and the firewall"] },
  [-102]: { title: UNREACHABLE, detail: (host) => `${host} refused to connect.`, hints: ["Checking the connection", "Checking the proxy and the firewall"] },
  [-104]: { title: UNREACHABLE, detail: (host) => `${host} couldn’t be reached.` },
  [-105]: { title: UNREACHABLE, detail: (host) => `${host}’s server IP address could not be found.`, hints: ["Checking the connection", "Checking the proxy, firewall and DNS configuration"] },
  [-106]: { title: "No internet", detail: () => "You’re offline.", hints: ["Checking the network cables, modem and router", "Reconnecting to Wi-Fi"] },
  [-109]: { title: UNREACHABLE, detail: (host) => `${host} is unreachable.` },
  [-118]: { title: UNREACHABLE, detail: (host) => `${host} took too long to respond.`, hints: ["Checking the connection", "Checking the proxy and the firewall"] },
  [-137]: { title: UNREACHABLE, detail: (host) => `${host}’s server IP address could not be found.` },
  [-324]: { title: "This page isn’t working", detail: (host) => `${host} didn’t send any data.` },
};

const certificateCopy: ErrorCopy = {
  title: "Your connection isn’t private",
  detail: (host) => `Attackers might be trying to steal your information from ${host} (for example, passwords, messages or credit cards).`,
};

const fallbackCopy: ErrorCopy = { title: UNREACHABLE, detail: (host) => `${host} couldn’t be loaded.` };

export const showsErrorPage = (code: number): boolean => code !== -3 && code !== 0;

function copyFor(code: number): ErrorCopy {
  if (code <= -200 && code > -300) return certificateCopy;
  return COPY[code] ?? fallbackCopy;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
};

const STYLE = `
:root{color-scheme:light dark;--ink:#202124;--muted:#5f6368;--accent:#1a73e8;--button-ink:#fff;--page:#fff}
@media (prefers-color-scheme:dark){:root{--ink:#e8eaed;--muted:#9aa0a6;--accent:#8ab4f8;--button-ink:#202124;--page:#202124}}
html,body{margin:0;background:var(--page);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Ubuntu,Cantarell,sans-serif}
main{box-sizing:border-box;max-width:600px;margin:14vh auto 0;padding:0 24px}
.glyph{width:72px;height:72px;margin-bottom:36px;opacity:.55}
h1{font-size:1.6em;font-weight:500;margin:0 0 16px;line-height:1.25}
p{margin:0 0 12px;color:var(--muted)}
ul{margin:4px 0 16px;padding-left:20px;color:var(--muted)}
.code{font-size:.82em;letter-spacing:.02em;text-transform:uppercase;margin-top:20px}
button{margin-top:28px;border:0;border-radius:8px;padding:9px 22px;font:inherit;font-weight:500;background:var(--accent);color:var(--button-ink);cursor:pointer}
button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
`;

const GLYPH = `<svg class="glyph" viewBox="0 0 72 72" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><rect x="8" y="12" width="56" height="44" rx="6"/><path d="M8 24h56M26 40l20 0M30 48h12"/></svg>`;

function script(page: { title: string; host: string; detail: string; hints: string[]; code: string }) {
  return `(() => {
  if (location.protocol !== "chrome-error:" || document.documentElement.dataset.ardiaError) return false;
  const page = ${JSON.stringify(page)};
  document.documentElement.dataset.ardiaError = "1";
  document.documentElement.lang = "en";
  document.title = page.host;
  const style = document.createElement("style");
  style.textContent = ${JSON.stringify(STYLE)};
  document.head.append(style);
  const main = document.createElement("main");
  main.innerHTML = ${JSON.stringify(GLYPH)};
  const heading = document.createElement("h1");
  heading.textContent = page.title;
  const detail = document.createElement("p");
  detail.textContent = page.detail;
  main.append(heading, detail);
  if (page.hints.length) {
    const lead = document.createElement("p");
    lead.textContent = "Try:";
    const list = document.createElement("ul");
    for (const hint of page.hints) {
      const item = document.createElement("li");
      item.textContent = hint;
      list.append(item);
    }
    main.append(lead, list);
  }
  const code = document.createElement("p");
  code.className = "code";
  code.textContent = page.code;
  const reload = document.createElement("button");
  reload.textContent = "Reload";
  reload.addEventListener("click", () => location.reload());
  main.append(code, reload);
  document.body.replaceChildren(main);
  reload.focus({ preventScroll: true });
  return true;
})()`;
}

export async function renderErrorPage(contents: WebContents, code: number, text: string, url: string): Promise<boolean> {
  if (contents.isDestroyed() || !showsErrorPage(code)) return false;
  const copy = copyFor(code);
  const host = hostOf(url);
  const page = { title: copy.title, host, detail: copy.detail(host), hints: copy.hints ?? [], code: text || `Error ${code}` };
  try {
    const shown = (await contents.mainFrame.executeJavaScript(script(page), false)) === true;
    if (shown) count("page_error_pages");
    return shown;
  } catch {
    return false;
  }
}
