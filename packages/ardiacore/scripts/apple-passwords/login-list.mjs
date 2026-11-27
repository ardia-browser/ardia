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
export const LIST_FAILED = "Apple Passwords didn't answer. Try again.";
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
  const COUNTED_SHOWN = `[logins] Login list counted: shown in ${engineName}\n`;
  const applePasswords = async (app) => app.eval("return ac.applePasswords.useApplePasswords.getState().state", { timeout: 20_000 });
  const pairingStep = async (app) => app.eval("return ac.applePasswords.useApplePasswords.getState().pairing?.step ?? null", { timeout: 20_000 });
  const prompting = async (app, tabId) => app.eval(`return ac.pageState.getState().pages[${q(tabId)}]?.applePasswordsPairing === true`, { timeout: 20_000 });
  const endPairing = async (app, fake) => {
    fake.endPairing();
    await waitFor("Pairing ended", async () => ((await applePasswords(app)) === "notConnected" ? true : null), 10_000);
  };
  const pairAgain = async (app, fake) => {
    await waitFor("the code step", async () => ((await pairingStep(app)) === "code" ? true : null), 20_000);
    await app.eval(`return ac.applePasswords.submitApplePasswordsCode(ac.applePasswords.pairingCodeSecret(${q(FIXTURES.code)})).then(() => true);`, { timeout: 60_000 });
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
    const shared = await paired();
    return (engineName === "chromium" ? shared.chromium : shared.tabs).open(sites.url(host, pathname));
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
    async E12() {
      const { fake } = await paired();
      const away = sites.url("other.localhost");
      const untouched = async (tab) => {
        const page = await tab.value(`({ href: location.href, u: document.getElementById("u").value, p: document.getElementById("p").value, events: ${PAGE_EVENTS}.filter((e) => e[0] !== "focusin") })`);
        assert(page.href === away && !page.u && !page.p && !page.events.length, "the other site's page receives nothing", { href: page.href, u: page.u, filled: !!page.p, events: page.events });
      };
      await (await open("other.localhost")).close();
      const seen = {};
      const opened = await open("example.localhost");
      try {
        await opened.click("#u");
        await opened.waitRows();
        await opened.navigate(away);
        assert(!(await opened.noList(1000)), "the list closes when the page goes to another site", null);
        await untouched(opened);
        seen.listOpen = "nothing";
      } finally {
        await opened.close();
      }
      const picked = await open("example.localhost");
      fake.setMode({ delay: { 5: 2500 } });
      try {
        await picked.click("#u");
        await picked.waitRows();
        await picked.pick(usersFor("example.localhost")[0]);
        await picked.navigate(away);
        await sleep(3500);
        await untouched(picked);
        seen.picked = "nothing";
      } finally {
        fake.setMode({ delay: {} });
        await picked.close();
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
    async E28frame() {
      const seen = {};
      for (const frameHost of ["example.localhost"]) {
        const tab = await open("example.localhost", `/framed?frame=${frameHost}`);
        const framed = () => tab.value(`${PAGE_EVENTS}.filter((e) => e[0] === "framed").map((e) => e.slice(1).join(":"))`);
        try {
          const frame = await waitFor("the frame", () => tab.value(`(() => { const r = document.getElementById("frame").getBoundingClientRect(); return { x: r.x, y: r.y } })()`), 5000);
          await waitFor(`the sign-in page framed from ${frameHost}`, async () => {
            await tab.clickAt(frame.x + 190, frame.y + 55);
            return (await framed())?.includes("focusin:u") || null;
          }, 10_000);
          const rows = await tab.waitRows(`the Login list in a frame from ${frameHost}`);
          assert(q(titles(rows)) === q([...usersFor("example.localhost"), FOOTER]), `a sign-in frame from ${frameHost} on example.localhost lists the site's logins`, rows);
          await tab.pick(usersFor("example.localhost")[0]);
          const events = await waitFor(`the fill in the frame from ${frameHost}`, async () => {
            const now = await framed();
            return now?.includes("change:p") ? now : null;
          }, 10_000).catch(async () => {
            throw new Error(`the picked login fills the frame from ${frameHost}: saw ${q(await framed())}`);
          });
          assert(q(events.filter((e) => !e.startsWith("focusin")).slice(-4)) === q(["input:u", "change:u", "input:p", "change:p"]), `the frame from ${frameHost} hears input and change`, events);
          seen[frameHost] = titles(rows);
        } finally {
          await tab.close();
        }
      }
      return { engine: engineName, ...seen };
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
    async E16dropped() {
      const { fake } = await paired();
      const tab = await open("example.localhost");
      try {
        fake.dropNext(4);
        await tab.click("#u");
        const failed = await tab.waitRows("the list whose fetch got no answer", 20_000);
        assert(failed[0]?.notice && failed[0].title === LIST_FAILED, `a fetch with no answer says ${LIST_FAILED}`, failed);
        await tab.key("escape");
        assert(!(await tab.noList(800)), "Escape closes it", null);
        await tab.click("#u");
        const rows = await waitFor("the logins on the next fetch", async () => {
          const shown = await tab.rows();
          return shown?.length && !shown[0].notice ? shown : null;
        }, 8000);
        assert(q(titles(rows.slice(0, -1))) === q(usersFor("example.localhost")), "the next Login list fetch lists the site's logins", rows);
        return { engine: engineName, failed: titles(failed), next: titles(rows) };
      } finally {
        await tab.close();
      }
    },
    async E16held() {
      const { app, fake } = await paired();
      const held = await open("example.localhost");
      let other = null;
      fake.setMode({ delay: { 5: 30_000 } });
      try {
        await held.click("#u");
        await held.waitRows();
        await held.pick(usersFor("example.localhost")[0]);
        await sleep(500);
        const asked = Date.now();
        const state = await app.eval(`return ac.engine.call("passwords.applePasswordsStatus", {})`, { timeout: 3000 }).catch((e) => ({ error: String(e) }));
        const statusMs = Date.now() - asked;
        assert(state?.state === "connected" && statusMs < 2000, "status answers at once while a password waits", { state, statusMs });
        other = await open("other.localhost");
        await other.click("#u");
        const rows = await other.waitRows("another tab's Login list while a password waits", 5000);
        assert(q(titles(rows.slice(0, -1))) === q(usersFor("other.localhost")), "another tab lists its site's logins", rows);
        return { engine: engineName, statusMs, other: titles(rows) };
      } finally {
        fake.setMode({ delay: {} });
        await held.close();
        await other?.close();
      }
    },
    async E34fetches() {
      const { fake } = await paired();
      const tab = await open("filter.localhost", "/login-ready");
      try {
        const fetches = () => fake.requests().filter((r) => r.cmd === 4).length;
        const before = fetches();
        await tab.click("#u");
        await tab.waitRows();
        const typed = "anna@example";
        await typedRows(tab, typed, ["anna@example.test", FOOTER], `the list for ${typed}`);
        await sleep(500);
        assert(fetches() - before === 1, `clicking and typing ${typed.length} characters fetch the site's logins once`, fetches() - before);
        return { engine: engineName, typed: typed.length, fetches: fetches() - before };
      } finally {
        await tab.close();
      }
    },
    async E34fresh() {
      const { fake } = await paired();
      const added = { user: "anneliese@new.test", password: "fixture-pw-anneliese-20", sites: ["filter.localhost"] };
      const tab = await open("filter.localhost", "/login-ready");
      try {
        await tab.click("#u");
        await tab.waitRows();
        await typedRows(tab, "an", [...FILTERED, FOOTER], "the list for an");
        await tab.key("escape");
        assert(!(await tab.noList(800)), "Escape closes the list", null);
        fake.setLogins((logins) => [...logins, added]);
        await tab.type("n");
        const rows = await waitFor("the login just added in Passwords", async () => {
          const shown = await tab.rows();
          return shown?.some((r) => r.title === added.user) ? shown : null;
        }, 5000).catch(async () => {
          throw new Error(`the list reopened by typing lists a login just added in Passwords: saw ${q(titles((await tab.rows()) ?? []))}`);
        });
        return { engine: engineName, rows: titles(rows) };
      } finally {
        fake.setLogins((logins) => logins.filter((l) => l.user !== added.user));
        await tab.close();
      }
    },
    async E34() {
      const { app } = await paired();
      const shownCounts = () => app.output().split(COUNTED_SHOWN).length - 1;
      const tab = await open("filter.localhost", "/login-ready");
      try {
        const before = shownCounts();
        await tab.click("#u");
        const all = await tab.waitRows();
        assert(q(titles(all.slice(0, -1))) === q(usersFor("filter.localhost")), "the click lists every login for the site", all);
        await typedRows(tab, "an", [...FILTERED, FOOTER], "the list for an");
        await typedRows(tab, "n", [...FILTERED, FOOTER], "the list for ann");
        await sleep(300);
        assert(shownCounts() - before === 1, "refiltering an open list counts one showing", shownCounts() - before);
        return { engine: engineName, an: FILTERED, shownCounted: shownCounts() - before };
      } finally {
        await tab.close();
      }
    },
    async E35() {
      const { app } = await paired();
      const shownCounts = () => app.output().split(COUNTED_SHOWN).length - 1;
      const tab = await open("filter.localhost", "/login-ready");
      try {
        const before = shownCounts();
        await tab.click("#u");
        await tab.waitRows();
        await typedRows(tab, "an", [...FILTERED, FOOTER], "the list for an");
        await tab.type("zzz");
        await waitFor("the list closed on zzz", async () => ((await tab.rows())?.length ? null : true), 5000);
        assert(!(await tab.noList(800)), "a list that matches nothing stays closed", null);
        for (let i = 0; i < 3; i++) await tab.key("backspace");
        assert((await tab.value(`document.getElementById("u").value`)) === "an", "Backspace leaves an", null);
        await typedRows(tab, "", [...FILTERED, FOOTER], "the list back on an");
        await sleep(300);
        assert(shownCounts() - before === 2, "closing on no match and reopening on Backspace counts two showings", shownCounts() - before);
        return { engine: engineName, back: FILTERED, shownCounted: shownCounts() - before };
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
    async E38() {
      const tab = await open("filter.localhost", "/login-ready");
      const bolds = (rows) => rows.map((r) => [r.title, r.bold]);
      try {
        await tab.click("#u");
        const all = await tab.waitRows();
        assert(all.every((r) => !r.bold), "nothing is bold before typing", bolds(all));
        const an = await typedRows(tab, "an", [...FILTERED, FOOTER], "the list for an");
        const wantAn = [["anna@example.test", "an"], ["Ännabel", "Än"], ["joanna.k@mail.test", "an"], [FOOTER, ""]];
        assert(q(bolds(an)) === q(wantAn), "each row's matched run is bold", bolds(an));
        const ann = await typedRows(tab, "n", [...FILTERED, FOOTER], "the list for ann");
        const wantAnn = [["anna@example.test", "ann"], ["Ännabel", "Änn"], ["joanna.k@mail.test", "ann"], [FOOTER, ""]];
        assert(q(bolds(ann)) === q(wantAnn), "the bold run follows the typing", bolds(ann));
        return { engine: engineName, an: bolds(an), ann: bolds(ann) };
      } finally {
        await tab.close();
      }
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
