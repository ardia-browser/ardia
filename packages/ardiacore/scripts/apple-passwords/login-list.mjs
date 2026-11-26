import { FIXTURES } from "./fake.mjs";
import { PAGE_EVENTS } from "./sites.mjs";
import { waitFor } from "./webkit.mjs";

const q = JSON.stringify;
export const APPLE_ICON = "Apple Passwords";
export const FOOTER = "Open Passwords app";

const usersFor = (host) =>
  FIXTURES.logins
    .filter((l) => l.sites.some((s) => s === host))
    .map((l) => l.user)
    .sort((a, b) => a.localeCompare(b));

const assert = (ok, message, detail) => {
  if (!ok) throw new Error(`${message}: ${q(detail)}`);
};

const titles = (rows) => rows.map((r) => r.title);

export function loginListChecks({ paired, sites, engine: engineName = "webkit" }) {
  const open = async (host, pathname = "/login") => {
    const { tabs } = await paired();
    return tabs.open(sites.url(host, pathname));
  };

  return {
    async E5() {
      const tab = await open("example.localhost");
      try {
        await tab.click("#u");
        const rows = await tab.waitRows();
        const logins = rows.slice(0, -1);
        assert(q(titles(logins)) === q(usersFor("example.localhost")), "only the site's logins are listed", rows);
        assert(logins.every((r) => !r.notice && r.icon === APPLE_ICON), "each login row has the Apple key icon", rows);
        assert(rows.at(-1).title === FOOTER && !rows.at(-1).notice, `the list ends in ${FOOTER}`, rows);
        return { engine: engineName, rows: titles(rows) };
      } finally {
        await tab.close();
      }
    },
    async E6() {
      const tab = await open("example.localhost");
      try {
        const login = FIXTURES.logins.find((l) => l.user === usersFor("example.localhost")[1]);
        await tab.click("#u");
        await tab.waitRows();
        await tab.pick(login.user);
        const filled = await waitFor("the filled login", async () => {
          const page = await tab.value(`({ u: document.getElementById("u").value, p: document.getElementById("p").value, go: !document.getElementById("go").disabled, events: ${PAGE_EVENTS}.filter((e) => e[0] !== "focusin").map((e) => e.join(":")) })`);
          return page?.p ? page : null;
        });
        assert(filled.u === login.user && filled.p === login.password, "the picked login fills both fields", { u: filled.u, filled: !!filled.p });
        assert(q(filled.events.slice(-4)) === q(["input:u", "change:u", "input:p", "change:p"]), "the page hears input and change", filled.events);
        assert(filled.go, "the page enables its button", filled);
        assert(!(await tab.rows())?.length, "the list closes", null);
        return { engine: engineName, events: filled.events.length };
      } finally {
        await tab.close();
      }
    },
    async E7() {
      const tab = await open("example.localhost");
      try {
        const first = FIXTURES.logins.find((l) => l.user === usersFor("example.localhost")[0]);
        await tab.click("#u");
        await tab.waitRows();
        await tab.key("escape");
        assert(!(await tab.noList(800)), "Escape closes the list", null);
        await tab.key("down");
        await tab.waitRows("the list ArrowDown opens");
        await tab.key("escape");
        assert(!(await tab.noList(800)), "Escape closes it again", null);
        await tab.key("down");
        await tab.waitRows("the list ArrowDown opens again");
        await tab.key("down");
        await tab.key("enter");
        const filled = await waitFor("the keyed fill", async () => {
          const page = await tab.value(`({ u: document.getElementById("u").value, p: document.getElementById("p").value })`);
          return page?.p ? page : null;
        });
        assert(filled.u === first.user && filled.p === first.password, "Down and Enter fill the first login", { u: filled.u });
        return { engine: engineName };
      } finally {
        await tab.close();
      }
    },
    async E9() {
      const tab = await open("accounts.example.localhost");
      try {
        await tab.click("#u");
        const rows = await tab.waitRows();
        assert(q(titles(rows.slice(0, -1))) === q(usersFor("example.localhost")), "example.localhost's logins are offered on its subdomain", rows);
        return { engine: engineName, rows: titles(rows) };
      } finally {
        await tab.close();
      }
    },
  };
}
