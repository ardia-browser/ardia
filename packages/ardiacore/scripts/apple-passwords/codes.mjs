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
  const open = async (host, pathname = "/code") => {
    const shared = await paired();
    return (engineName === "chromium" ? shared.chromium : shared.tabs).open(sites.url(host, pathname));
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
  };
}
