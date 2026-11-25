const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SITE = "http://fieldnotes.example";
const READ_AFTER_LOAD_MS = 9000;

async function readPage(instance) {
  const end = Date.now() + 20000;
  let page = null;
  while (!page && Date.now() < end) page = await instance.page("fieldnotes.example", { timeout: 500 }).catch(() => null);
  if (!page) return [{ t: Date.now(), pageMissing: 1 }];
  const found = Date.now();
  await sleep(READ_AFTER_LOAD_MS);
  const state = await page.eval("JSON.stringify({ log: window.__pageFocus, y: scrollY, focus: document.hasFocus() })").catch((e) => JSON.stringify({ error: String(e) }));
  page.close();
  const { log, y, focus, error } = JSON.parse(state);
  if (error || !log) return [{ t: Date.now(), pageMissing: 1, error }];
  return [
    { t: found, pageFound: 1 },
    ...log.keys.map((k) => ({ t: k.t, pageKey: k.key, pageY: k.y })),
    ...log.focus.map((f) => ({ t: f.t, pageFocus: f.f ? 1 : 0 })),
    { t: Date.now(), pageFinal: 1, pageY: y, pageFocus: focus ? 1 : 0 },
  ];
}

export default {
  session: "session-page-focus.json",
  instance: { jsLocation: "localhost:8081" },
  setup: `return sleep(1500).then(() => done());`,
  external: readPage,
  act: `const typeUrl = (text) => [...text].reduce((p, ch) => p.then(() => dw("type:" + ch)).then(() => sleep(45)), Promise.resolve());
const pressKey = (k) => key(k, 0, k, KEYCODES[k]);
const activeUrl = () => { const t = st().tabs[st().windows[W].activeTabIds[st().windows[W].profileId]]; return t ? t.url : null; };
return sleep(600)
  .then(() => { mark("go"); return key("⌘T", CMD, "t", 17); })
  .then(() => sleep(800)).then(() => typeUrl(${JSON.stringify(SITE)})).then(() => sleep(450))
  .then(() => key("↩", 0, String.fromCharCode(13), 36))
  .then(() => sleep(1600))
  .then(() => ["j", "j", "j", "j"].reduce((p, k) => p.then(() => pressKey(k)).then(() => sleep(750)), Promise.resolve()))
  .then(() => sleep(350)).then(() => pressKey("k")).then(() => sleep(1700))
  .then(() => done({ url: activeUrl() }));`,
  tail: 600,
};
