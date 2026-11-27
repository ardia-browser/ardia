import { FIXTURES } from "./fake.mjs";
import { FOOTER } from "./login-list.mjs";
import { PAGE_EVENTS } from "./sites.mjs";
import { waitFor } from "./webkit.mjs";

const q = JSON.stringify;
const SITE = "example.localhost";
export const codeTitle = (site) => `Code for ${site}`;

const assert = (ok, message, detail) => {
  if (!ok) throw new Error(`${message}: ${q(detail)}`);
};

const codesFor = (domain) => FIXTURES.codes.filter((c) => c.domain === domain);

export function codeChecks({ paired, sites, engine: engineName = "webkit" }) {
  const openUrl = async (url) => {
    const shared = await paired();
    return (engineName === "chromium" ? shared.chromium : shared.tabs).open(url);
  };
  const open = (host, pathname = "/code") => openUrl(sites.url(host, pathname));
  const PICK_SETTLED_MS = 2000;
  const codeRows = (rows) => (rows ?? []).filter((r) => r.title.startsWith(codeTitle("")));
  const untouched = async (tab, value, what) => {
    await new Promise((r) => setTimeout(r, PICK_SETTLED_MS));
    const page = await codeField(tab);
    assert(page.c === value && !page.events.length, what, { kept: page.c === value, events: page.events });
  };
  const codeField = (tab) => tab.value(`({ c: document.getElementById("c").value, events: ${PAGE_EVENTS}.filter((e) => e[0] !== "focusin").map((e) => e.join(":")) })`);

  return {
    async E25() {
      const tab = await open(SITE);
      try {
        await tab.click("#c");
        const rows = await tab.waitRows();
        const codes = codesFor(SITE);
        assert(q(rows.map((r) => r.label)) === q([...codes.map((c) => `${codeTitle(SITE)}, ${c.username}`), FOOTER]), `the code field lists "${codeTitle(SITE)}" for each account, then ${FOOTER}`, rows);
        await tab.pick(codeTitle(SITE));
        const filled = await waitFor("the filled code", async () => {
          const page = await codeField(tab);
          return page?.c ? page : null;
        });
        assert(filled.c === codes[0].code, "picking it fills the account's current code", { filled: filled.c.length });
        assert(q(filled.events.slice(-2)) === q(["input:c", "change:c"]), "the page hears input and change", filled.events);
        assert(!(await tab.rows())?.length, "the list closes", null);
        return { engine: engineName, rows: rows.map((r) => r.label) };
      } finally {
        await tab.close();
      }
    },
    async E26() {
      const codes = codesFor(SITE);
      const typed = codes.at(-1);
      const tab = await open(SITE, "/login");
      try {
        await tab.click("#u");
        await tab.waitRows();
        await tab.type(typed.username);
        await waitFor("the typed account", async () => ((await tab.value(`document.getElementById("u").value`)) === typed.username ? true : null), 5000);
        await tab.key("escape");
        await tab.navigate(sites.url(SITE, "/code"));
        await tab.click("#c");
        const rows = await tab.waitRows();
        const others = codes.filter((c) => c !== typed);
        assert(q(rows.map((r) => r.label)) === q([typed, ...others].map((c) => `${codeTitle(SITE)}, ${c.username}`).concat(FOOTER)), "the typed account's code is first", rows);
        await tab.pick(codeTitle(SITE));
        const filled = await waitFor("the filled code", async () => {
          const page = await codeField(tab);
          return page?.c ? page : null;
        });
        assert(filled.c === typed.code, "the top row fills the typed account's code", { filled: filled.c.length });
        return { engine: engineName, rows: rows.map((r) => r.label) };
      } finally {
        await tab.close();
      }
    },
    async E27() {
      const seen = {};
      const PLAIN = "plain.localhost";
      const secure = await openUrl(sites.secureUrl(PLAIN, "/code"));
      try {
        await secure.click("#c");
        const rows = await secure.waitRows();
        assert(codeRows(rows).length === codesFor(PLAIN).length, `the https page lists ${codeTitle(PLAIN)} (control)`, rows);
        seen.https = rows.map((r) => r.label);
        await secure.key("escape");
      } finally {
        await secure.close();
      }
      const plain = await open(PLAIN);
      try {
        await plain.click("#c");
        await waitFor("the code field focused", () => plain.value(`${PAGE_EVENTS}.some((e) => e[0] === "focusin" && e[1] === "c") || null`), 5000);
        await plain.key("down");
        const rows = await plain.noList(1500);
        assert(!codeRows(rows).length, "an http code field shows no code row", rows);
        seen.http = rows ? rows.map((r) => r.label) : "no list";
      } finally {
        await plain.close();
      }
      const holding = await open(SITE, "/code-filled");
      try {
        await holding.click("#c");
        const rows = await holding.noList(1500);
        if (codeRows(rows).length) await holding.pick(codeTitle(SITE));
        await untouched(holding, "12", "a code field that already holds text is not overwritten");
        seen.holding = codeRows(rows).length ? "row shown, nothing filled" : "no code row";
      } finally {
        await holding.close();
      }
      const typedSince = await open(SITE);
      try {
        await typedSince.click("#c");
        await typedSince.waitRows();
        await typedSince.value(`(document.getElementById("c").value = "34")`);
        await typedSince.pick(codeTitle(SITE));
        await untouched(typedSince, "34", "a code field that took text after the list opened is not overwritten");
        seen.typedSince = "kept";
      } finally {
        await typedSince.close();
      }
      return { engine: engineName, ...seen };
    },
  };
}
