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
  };
}
