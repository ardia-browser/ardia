import { FIXTURES } from "./fake.mjs";
import { PAGE_EVENTS } from "./sites.mjs";
import { sleep } from "../../../../scripts/lib/instance.mjs";
import { waitFor } from "./webkit.mjs";

const q = JSON.stringify;
export const APPLE_ICON = "Apple Passwords";
export const FOOTER = "Open Passwords app";
export const NO_LOGINS = "No saved logins";
export const NOT_SECURE = "Not secure";
export const CONNECT = "Connect Apple Passwords";
export const NOT_NOW = "Not now";
export const FILL_FAILED = "Apple Passwords didn't fill this login. Unlock the Passwords app and try again.";
const OPENED_PASSWORDS = "[logins] Passwords app (background mode, not opened)";

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
  const applePasswords = async (app) => app.eval("return ac.applePasswords.useApplePasswords.getState().state", { timeout: 20_000 });
  const pairingStep = async (app) => app.eval("return ac.applePasswords.useApplePasswords.getState().pairing?.step ?? null", { timeout: 20_000 });
  const prompting = async (app, tabId) => app.eval(`return ac.pageState.getState().pages[${q(tabId)}]?.applePasswordsPairing === true`, { timeout: 20_000 });
  const endPairing = async (app, fake) => {
    fake.endPairing();
    await waitFor("Pairing ended", async () => ((await applePasswords(app)) === "notConnected" ? true : null), 10_000);
  };
  const pairAgain = async (app, fake) => {
    await waitFor("the code step", async () => ((await pairingStep(app)) === "code" ? true : null), 20_000);
    await app.eval(`return ac.applePasswords.submitApplePasswordsCode(${q(FIXTURES.code)}).then(() => true);`, { timeout: 60_000 });
    await waitFor("Paired again", async () => ((await applePasswords(app)) === "connected" ? true : null), 20_000);
  };
  const connectRows = async (tab) => {
    await tab.click("#u");
    const rows = await tab.waitRows();
    assert(rows[0]?.title === CONNECT && !rows[0].notice, `the list starts with ${CONNECT}`, rows);
    assert(rows.some((r) => r.title === NOT_NOW && !r.notice), `the list offers ${NOT_NOW}`, rows);
    assert(!rows.some((r) => FIXTURES.logins.some((l) => l.user === r.title)), "no login rows while Pairing has ended", rows);
    return rows;
  };

  const typedRows = async (tab, text, expected, what) => {
    if (text) await tab.type(text);
    let seen = null;
    return waitFor(what, async () => {
      seen = await tab.rows();
      return seen && q(titles(seen)) === q(expected) ? seen : null;
    }, 10_000).catch(() => {
      throw new Error(`${what}: wanted ${q(expected)}, saw ${q(seen && titles(seen))}`);
    });
  };
  const FILTERED = ["anna@example.test", "Ännabel", "joanna.k@mail.test"];

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
    async E10() {
      const { app } = await paired();
      const tab = await open("empty.localhost");
      try {
        await tab.click("#u");
        const rows = await tab.waitRows();
        assert(q(rows.map((r) => [r.title, r.notice])) === q([[NO_LOGINS, true], [FOOTER, false]]), `the list says ${NO_LOGINS} and offers ${FOOTER}`, rows);
        const before = app.output().split(OPENED_PASSWORDS).length;
        await tab.pick(FOOTER);
        await waitFor("the Passwords app asked to open", async () => (app.output().split(OPENED_PASSWORDS).length > before ? true : null), 5000);
        assert(!(await tab.rows())?.length, "the list closes", null);
        return { engine: engineName, rows: titles(rows) };
      } finally {
        await tab.close();
      }
    },
    async E11() {
      const seen = {};
      for (const [pathname, field] of [["/search", "#q"], ["/newsletter", "#email"]]) {
        const tab = await open("example.localhost", pathname);
        try {
          await tab.click(field);
          await waitFor(`${field} focused`, () => tab.value(`${PAGE_EVENTS}.some((e) => e[0] === "focusin" && e[1] === ${q(field.slice(1))}) || null`), 5000);
          await tab.key("down");
          const rows = await tab.noList(1500);
          assert(!rows, `${pathname} opens no list`, rows);
          seen[pathname] = "no list";
        } finally {
          await tab.close();
        }
      }
      return { engine: engineName, ...seen };
    },
    async E13() {
      await (await open("other.localhost")).close();
      const tab = await open("example.localhost", "/framed?frame=other.localhost");
      try {
        const frame = await waitFor("the frame", () => tab.value(`(() => { const r = document.getElementById("frame").getBoundingClientRect(); return { x: r.x, y: r.y } })()`), 5000);
        await waitFor("the framed sign-in page", async () => {
          await tab.clickAt(frame.x + 190, frame.y + 55);
          return tab.value(`${PAGE_EVENTS}.some((e) => e[0] === "framed" && e[1] === "focusin" && e[2] === "u") || null`);
        }, 10_000);
        await tab.key("down");
        const rows = await tab.noList(1500);
        assert(!rows, "another site's login box in a frame gets no Apple Passwords rows", rows);
        return { engine: engineName, list: "none" };
      } finally {
        await tab.close();
      }
    },
    async E14() {
      const tab = await open("plain.localhost");
      try {
        await tab.click("#u");
        const rows = await tab.waitRows();
        const logins = rows.slice(0, -1);
        assert(q(titles(logins)) === q(usersFor("http://plain.localhost")), "only the logins saved for http are offered", rows);
        assert(logins.every((r) => r.label === `${r.title}, ${NOT_SECURE}`), `each is marked ${NOT_SECURE}`, rows);
        const secure = FIXTURES.logins.filter((l) => l.sites.includes("plain.localhost")).map((l) => l.user);
        assert(secure.length && !secure.some((u) => titles(rows).includes(u)), "the site's https login is never offered over http", rows);
        return { engine: engineName, rows: rows.map((r) => r.label) };
      } finally {
        await tab.close();
      }
    },
    async E15() {
      const { app, fake } = await paired();
      const seen = {};
      await endPairing(app, fake);
      const tab = await open("example.localhost");
      try {
        seen.ended = titles(await connectRows(tab));
        await tab.pick(CONNECT);
        await waitFor("the Pairing prompt over the page", async () => ((await prompting(app, tab.id)) ? true : null), 10_000);
        await pairAgain(app, fake);
        await waitFor("the Pairing prompt gone", async () => ((await prompting(app, tab.id)) ? null : true), 10_000);
        const back = await tab.waitRows("the logins after Pairing");
        assert(q(titles(back.slice(0, -1))) === q(usersFor("example.localhost")), "Pairing there brings the site's logins back", back);
        seen.paired = titles(back);
        await tab.key("escape");
        await endPairing(app, fake);
        await connectRows(tab);
        await tab.pick(NOT_NOW);
        assert(!(await tab.noList(800)), `${NOT_NOW} closes the list`, null);
        await tab.click("#u");
        const away = await tab.noList(1500);
        assert(!away, `${NOT_NOW} keeps the row away on that site`, away);
        seen.notNow = "no list";
      } finally {
        await tab.close();
      }
      const other = await open("other.localhost");
      try {
        seen.otherSite = titles(await connectRows(other));
        await other.key("escape");
      } finally {
        await other.close();
      }
      await app.eval("return ac.applePasswords.startApplePasswordsPairing(null).then(() => true);", { timeout: 30_000 });
      await pairAgain(app, fake);
      await endPairing(app, fake);
      const again = await open("example.localhost");
      try {
        seen.nextEnd = titles(await connectRows(again));
        await again.pick(CONNECT);
        await pairAgain(app, fake);
        await again.waitRows("the logins after Pairing again");
      } finally {
        await again.close();
      }
      return { engine: engineName, ...seen };
    },
    async E16() {
      const { fake } = await paired();
      const seen = {};
      for (const [kind, status] of [["locked", 2], ["refused", 5]]) {
        const tab = await open("example.localhost");
        fake.setMode({ status: { 5: status } });
        try {
          const login = usersFor("example.localhost")[0];
          await tab.click("#u");
          await tab.waitRows();
          await tab.pick(login);
          const rows = await waitFor("the failure row", async () => {
            const shown = await tab.rows();
            return shown?.[0]?.notice ? shown : null;
          });
          assert(rows[0].notice && rows[0].title === FILL_FAILED, "a failure row says the login wasn't filled", rows);
          const page = await tab.value(`({ u: document.getElementById("u").value, p: document.getElementById("p").value })`);
          assert(!page.u && !page.p, "nothing is filled", { u: page.u, filled: !!page.p });
          seen[kind] = rows[0].title;
        } finally {
          fake.setMode({ status: {} });
          await tab.close();
        }
      }
      return { engine: engineName, ...seen };
    },
    async E34() {
      const tab = await open("filter.localhost", "/login-ready");
      try {
        await tab.click("#u");
        const all = await tab.waitRows();
        assert(q(titles(all.slice(0, -1))) === q(usersFor("filter.localhost")), "the click lists every login for the site", all);
        await typedRows(tab, "an", [...FILTERED, FOOTER], "the list for an");
        await typedRows(tab, "n", [...FILTERED, FOOTER], "the list for ann");
        return { engine: engineName, an: FILTERED };
      } finally {
        await tab.close();
      }
    },
    async E35() {
      const tab = await open("filter.localhost", "/login-ready");
      try {
        await tab.click("#u");
        await tab.waitRows();
        await typedRows(tab, "an", [...FILTERED, FOOTER], "the list for an");
        await tab.type("zzz");
        await waitFor("the list closed on zzz", async () => ((await tab.rows())?.length ? null : true), 5000);
        assert(!(await tab.noList(800)), "a list that matches nothing stays closed", null);
        for (let i = 0; i < 3; i++) await tab.key("backspace");
        assert((await tab.value(`document.getElementById("u").value`)) === "an", "Backspace leaves an", null);
        await typedRows(tab, "", [...FILTERED, FOOTER], "the list back on an");
        return { engine: engineName, back: FILTERED };
      } finally {
        await tab.close();
      }
    },
    async E36() {
      const tab = await open("filter.localhost", "/login-ready");
      const page = () => tab.value(`({ u: document.getElementById("u").value, p: document.getElementById("p").value, submits: ${PAGE_EVENTS}.filter((e) => e[0] === "submit").length })`);
      try {
        await tab.click("#u");
        await tab.waitRows();
        await typedRows(tab, "an", [...FILTERED, FOOTER], "the list for an");
        await tab.key("enter");
        const submitted = await waitFor("the form submitted", async () => {
          const now = await page();
          return now?.submits ? now : null;
        }, 5000);
        assert(submitted.u === "an" && !submitted.p, "Enter with no row chosen fills nothing", { u: submitted.u, filled: !!submitted.p });
        assert(!(await tab.noList(800)), "Enter closes the list", null);
        await typedRows(tab, "n", [...FILTERED, FOOTER], "the list for ann");
        await tab.key("escape");
        assert(!(await tab.noList(800)), "Escape closes the list", null);
        const kept = await page();
        assert(kept.u === "ann" && !kept.p && kept.submits === 1, "Escape keeps the typed text", { u: kept.u, submits: kept.submits });
        await tab.key("down");
        await typedRows(tab, "", [...FILTERED, FOOTER], "the list Down opens on ann");
        await tab.key("down");
        await tab.key("enter");
        const first = FIXTURES.logins.find((l) => l.user === FILTERED[0]);
        const filled = await waitFor("the keyed fill", async () => {
          const now = await page();
          return now?.p ? now : null;
        });
        assert(filled.u === first.user && filled.p === first.password, "Down then Enter fills the first row", { u: filled.u });
        assert(filled.submits === 1, "picking a row doesn't submit", filled.submits);
        return { engine: engineName, submitted: "an", kept: kept.u, filled: filled.u };
      } finally {
        await tab.close();
      }
    },
    async E37() {
      const { app, fake } = await paired();
      const every = [...usersFor("filter.localhost"), FOOTER];
      const seen = {};
      const tab = await open("filter.localhost", "/login-ready");
      try {
        await tab.click("#p");
        await typedRows(tab, "", every, "the list on the password field");
        await tab.type("an");
        await waitFor("the typed password", async () => ((await tab.value(`document.getElementById("p").value.length`)) === 2 ? true : null), 5000);
        await sleep(600);
        await typedRows(tab, "", every, "the same list after typing in the password field");
        seen.password = "unchanged";
        await tab.click("#u");
        await tab.waitRows();
        await typedRows(tab, "an", [...FILTERED, FOOTER], "the footer while filtering");
        seen.footer = FOOTER;
        await tab.key("escape");
        await endPairing(app, fake);
        await tab.click("#u");
        await tab.waitRows();
        await typedRows(tab, "n", [CONNECT, NOT_NOW], `${CONNECT} while filtering`);
        seen.connect = CONNECT;
        await tab.pick(CONNECT);
        await pairAgain(app, fake);
        await tab.waitRows("the logins after Pairing");
        await tab.key("escape");
      } finally {
        await tab.close();
      }
      return { engine: engineName, ...seen };
    },
    async E17() {
      const { app } = await paired();
      const ardiaOnly = "ardia-only@example.test";
      const origin = sites.origin("example.localhost");
      await app.eval(`return globalThis.expo.modules.ArdiaPasswords.save("", ${q(origin)}, ${q(ardiaOnly)}, "fixture-pw-ardia-6").then(() => true)`, { timeout: 20_000 });
      const kept = await app.eval(`return ac.engine.call("passwords.list", { profile: "" }).then((r) => r.passwords.some((p) => p.username === ${q(ardiaOnly)}))`, { timeout: 20_000 });
      assert(kept, "Ardia's own store holds a login for the site", kept);
      const tab = await open("example.localhost");
      try {
        await tab.click("#u");
        const rows = await tab.waitRows();
        assert(q(titles(rows.slice(0, -1))) === q(usersFor("example.localhost")), "only the Apple Passwords logins are listed", rows);
        return { engine: engineName, rows: titles(rows) };
      } finally {
        await tab.close();
      }
    },
  };
}
