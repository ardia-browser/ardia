import { FIXTURES } from "./fake.mjs";
import { CONNECT, FOOTER, NOT_NOW } from "./login-list.mjs";
import { SAVE_TITLE, UPDATE_TITLE } from "./saving.mjs";
import { PAGE_EVENTS } from "./sites.mjs";
import { sleep } from "../../../../scripts/lib/instance.mjs";
import { waitFor } from "./webkit.mjs";

const q = JSON.stringify;
export const SUGGEST = "Suggest strong password";
const SITE = "save.localhost";
export const ROTATED_USER = "rotate@save.test";
const ALPHABET = /^[A-Za-z0-9-]+$/;
const LOOK_ALIKES = /[0O1lI]/;
const CHROME_POPUP_MS = 2500;

const assert = (ok, message, detail) => {
  if (!ok) throw new Error(`${message}: ${q(detail)}`);
};

const shape = (password) => ({
  length: password.length,
  alphabet: ALPHABET.test(password),
  lookAlikes: LOOK_ALIKES.test(password),
  digit: /[0-9]/.test(password),
  upper: /[A-Z]/.test(password),
  lower: /[a-z]/.test(password),
});

export function strongPasswordChecks({ paired, sites, engine: engineName = "webkit", fresh }) {
  const session = async () => {
    const shared = await paired();
    return { ...shared, tabs: engineName === "chromium" ? shared.chromium : shared.tabs };
  };

  const suggested = async (tab, field = "#p") => {
    await tab.click(field);
    const rows = await tab.waitRows();
    assert(rows[0]?.title === SUGGEST && !rows[0].notice, `the list starts with ${SUGGEST}`, rows);
    assert(rows.at(-1)?.title === FOOTER, `the list ends in ${FOOTER}`, rows);
    assert(!rows.some((r) => FIXTURES.logins.some((l) => l.user === r.title)), "a new-password field lists no logins", rows);
    if (engineName === "chromium") {
      await sleep(CHROME_POPUP_MS);
      const popups = await tab.chromePopups();
      assert(!popups.length, "Chrome shows no generation popup of its own beside it", popups);
    }
    return rows;
  };

  const pickSuggestion = async (tab, ids) => {
    await tab.pick(SUGGEST);
    const filled = await waitFor("the suggested password in every new-password field", async () => {
      const page = await tab.value(`({ values: ${q(ids)}.map((id) => document.getElementById(id).value), events: ${PAGE_EVENTS}.filter((e) => e[0] !== "focusin").map((e) => e.join(":")) })`);
      return page?.values.every(Boolean) ? page : null;
    });
    const [first, ...rest] = filled.values;
    assert(rest.every((v) => v === first), "every new-password field holds the same password", filled.values.map((v) => v.length));
    for (const id of ids) assert(filled.events.includes(`input:${id}`) && filled.events.includes(`change:${id}`), `#${id} hears input and change`, filled.events);
    assert(!(await tab.rows())?.length, "the list closes", null);
    return first;
  };

  const applePasswords = (app) => app.eval("return ac.applePasswords.useApplePasswords.getState().state", { timeout: 20_000 });
  const pairingStep = (app) => app.eval("return ac.applePasswords.useApplePasswords.getState().pairing?.step ?? null", { timeout: 20_000 });
  const listed = async (tab, expected, what) => {
    let seen = null;
    return waitFor(what, async () => {
      seen = await tab.rows();
      return seen && q(seen.map((r) => r.title)) === q(expected) ? seen : null;
    }, 10_000).catch(() => {
      throw new Error(`${what}: wanted ${q(expected)}, saw ${q(seen?.map((r) => r.title) ?? null)}`);
    });
  };

  return {
    async E24notConnected() {
      const { app, fake, tabs } = await session();
      fake.endPairing();
      await waitFor("Pairing ended", async () => ((await applePasswords(app)) === "notConnected" ? true : null), 10_000);
      const seen = {};
      const tab = await tabs.open(sites.url(SITE, "/signup"));
      try {
        await tab.click("#p");
        seen.notConnected = (await listed(tab, [SUGGEST, CONNECT, NOT_NOW], "the strong row beside the Connect row")).map((r) => r.title);
        await tab.pick(NOT_NOW);
        assert(!(await tab.noList(800)), `${NOT_NOW} closes the list`, null);
        await tab.click("#p");
        seen.notNow = (await listed(tab, [SUGGEST, FOOTER], `the strong row after ${NOT_NOW}`)).map((r) => r.title);
        const password = await pickSuggestion(tab, ["p", "c"]);
        assert(shape(password).length >= 16, "the suggestion fills while Apple Passwords isn't connected", shape(password));
      } finally {
        await tab.close();
      }
      const other = await tabs.open(sites.url("other.localhost", "/signup"));
      try {
        await other.click("#p");
        await listed(other, [SUGGEST, CONNECT, NOT_NOW], "another site's strong row beside the Connect row");
        await other.pick(CONNECT);
        await waitFor("the code step", async () => ((await pairingStep(app)) === "code" ? true : null), 20_000);
        await app.eval(`return ac.applePasswords.submitApplePasswordsCode(${q(FIXTURES.code)}).then(() => true);`, { timeout: 60_000 });
        await waitFor("Paired again", async () => ((await applePasswords(app)) === "connected" ? true : null), 20_000);
        seen.connected = (await listed(other, [SUGGEST, FOOTER], "the strong row once connected")).map((r) => r.title);
      } finally {
        await other.close();
      }
      return { engine: engineName, ...seen };
    },
    async E24control() {
      const tab = await fresh(sites.url(SITE, "/signup"));
      await tab.click("#u");
      await tab.click("#p");
      const popups = await waitFor("Chrome's generation popup", async () => ((await tab.chromePopups()).length ? tab.chromePopups() : null), 10_000);
      return { engine: "chromium", manager: "ardia", chromePopups: popups.length };
    },
    async E24() {
      const { fake, tabs } = await session();
      const short = await tabs.open(sites.url(SITE, "/signup-short"));
      let shortShape;
      try {
        await suggested(short);
        shortShape = shape(await pickSuggestion(short, ["p", "c"]));
        assert(shortShape.length === 12 && shortShape.alphabet && !shortShape.lookAlikes, "a field with maxlength 12 gets a 12-character password", shortShape);
      } finally {
        await short.close();
      }
      const user = `strong-${engineName}-${Date.now()}@save.test`;
      const tab = await tabs.open(sites.url(SITE, "/signup"));
      try {
        await tab.click("#u");
        await tab.type(user);
        const rows = await suggested(tab);
        const password = await pickSuggestion(tab, ["p", "c"]);
        const made = shape(password);
        assert(made.length >= 16 && made.alphabet && !made.lookAlikes && made.digit && made.upper && made.lower, "a strong password: 16 or more letters, digits and hyphens with no look-alikes", made);
        await waitFor("the Create account button enabled", () => tab.value(`!document.getElementById("go").disabled || null`), 5000);
        await tab.value(`(document.documentElement.dataset.signingIn = "yes")`);
        await tab.click("#go");
        await waitFor("the page after signing up", () => tab.value(`!document.documentElement.dataset.signingIn && location.pathname === "/signed-in" && document.readyState === "complete" || null`), 20_000);
        const prompt = await waitFor("the save prompt", () => tab.prompt(), 20_000);
        assert(prompt.state === "save" && prompt.username === user && prompt.copy.title === SAVE_TITLE, `the prompt asks ${SAVE_TITLE} for the new account`, { state: prompt.state, username: prompt.username, title: prompt.copy.title });
        assert(await tab.answer("save"), "Save is pressed", null);
        const saved = await waitFor("the new login in Apple Passwords", async () => fake.savedLogins().find((l) => l.user === user) ?? null, 20_000);
        assert(saved.password === password && saved.sites.includes(SITE), "Apple Passwords keeps the suggested password", { sites: saved.sites, same: saved.password === password });
        return { engine: engineName, rows: rows.map((r) => r.title), short: shortShape.length, length: made.length, title: prompt.copy.title };
      } finally {
        await tab.close();
      }
    },
    async E24change() {
      const { fake, tabs } = await session();
      const current = fake.savedLogins().find((l) => l.user === ROTATED_USER);
      assert(current, `the fake keeps ${ROTATED_USER}`, null);
      const tab = await tabs.open(sites.url(SITE, "/change-password"));
      try {
        await tab.click("#o");
        await tab.type(current.password);
        await waitFor("the current password typed", async () => ((await tab.value(`document.getElementById("o").value.length`)) === current.password.length ? true : null), 5000);
        await tab.key("escape");
        await suggested(tab);
        const password = await pickSuggestion(tab, ["p", "c"]);
        assert(password !== current.password, "the suggested password is a new one", null);
        await waitFor("the Change password button enabled", () => tab.value(`!document.getElementById("go").disabled || null`), 5000);
        await tab.value(`(document.documentElement.dataset.signingIn = "yes")`);
        await tab.click("#go");
        await waitFor("the page after changing the password", () => tab.value(`!document.documentElement.dataset.signingIn && location.pathname === "/signed-in" && document.readyState === "complete" || null`), 20_000);
        const prompt = await waitFor("the update prompt", () => tab.prompt(), 20_000);
        assert(prompt.state === "update" && prompt.username === ROTATED_USER && prompt.copy.title === UPDATE_TITLE, `the prompt asks ${UPDATE_TITLE} for the account`, { state: prompt.state, username: prompt.username, title: prompt.copy.title });
        assert(await tab.answer("update"), "Update is pressed", null);
        await waitFor("the suggested password in Apple Passwords", async () => (fake.savedLogins().find((l) => l.user === ROTATED_USER)?.password === password ? true : null), 20_000);
        const copies = fake.savedLogins().filter((l) => l.user === ROTATED_USER);
        assert(copies.length === 1, "the login is changed, not added again", copies.length);
        return { engine: engineName, title: prompt.copy.title, length: password.length };
      } finally {
        await tab.close();
      }
    },
  };
}
