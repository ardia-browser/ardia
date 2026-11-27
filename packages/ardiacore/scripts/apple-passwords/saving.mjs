import { FIXTURES } from "./fake.mjs";
import { waitFor } from "./webkit.mjs";

const q = JSON.stringify;
export const SAVE_TITLE = "Save to Apple Passwords?";
export const UPDATE_TITLE = "Update in Apple Passwords?";
const SITE = "save.localhost";

const assert = (ok, message, detail) => {
  if (!ok) throw new Error(`${message}: ${q(detail)}`);
};

export function savingChecks({ paired, sites, engine: engineName = "webkit" }) {
  const ardiaStore = async (app) => (await app.eval(`return ac.engine.call("passwords.list", { profile: "" })`, { timeout: 20_000 })).passwords.map((p) => `${p.origin} ${p.username}`).sort();

  async function signIn(tab, user, password, landing = "/signed-in") {
    await tab.click("#u");
    await tab.type(user);
    await tab.click("#p");
    await tab.type(password);
    await waitFor("the Sign in button enabled", () => tab.value(`!document.getElementById("go").disabled || null`), 5000);
    await tab.click("#go");
    await waitFor("the page after signing in", async () => ((await tab.value("location.pathname")) === landing && (await tab.value("document.readyState")) === "complete" ? true : null), 20_000);
  }

  const promptShown = (tab, what = "the save prompt") => waitFor(what, () => tab.prompt(), 20_000);
  const fixture = (user) => FIXTURES.logins.find((l) => l.user === user);

  return {
    async E18() {
      const { app, fake, tabs } = await paired();
      const login = { user: `new-${Date.now()}@save.test`, password: "fixture-pw-new-9" };
      const before = await ardiaStore(app);
      const tab = await tabs.open(sites.url(SITE));
      try {
        await signIn(tab, login.user, login.password);
        const prompt = await promptShown(tab);
        assert(prompt.state === "save" && prompt.username === login.user, "the prompt offers to save the new login", prompt);
        assert(prompt.copy.title === SAVE_TITLE, `the prompt asks ${SAVE_TITLE}`, prompt.copy);
        assert(await tab.answer("save"), "Save is pressed", null);
        const saved = await waitFor("the login in Apple Passwords", async () => fake.savedLogins().find((l) => l.user === login.user) ?? null, 20_000);
        assert(saved.password === login.password && saved.sites.includes(SITE), "Save puts the login in Apple Passwords", { user: saved.user, sites: saved.sites });
        const after = await ardiaStore(app);
        assert(q(after) === q(before), "Ardia's own store is unchanged", { before, after });
        return { engine: engineName, title: prompt.copy.title, ardiaStore: after.length };
      } finally {
        await tab.close();
      }
    },
    async E19() {
      const { fake, tabs } = await paired();
      const kept = fixture("changed@save.test");
      const changed = "fixture-pw-changed-10";
      const tab = await tabs.open(sites.url(SITE));
      try {
        await signIn(tab, kept.user, changed);
        const prompt = await promptShown(tab, "the update prompt");
        assert(prompt.state === "update" && prompt.username === kept.user, "the prompt offers to update the saved login", prompt);
        assert(prompt.copy.title === UPDATE_TITLE, `the prompt asks ${UPDATE_TITLE}`, prompt.copy);
        assert(await tab.answer("update"), "Update is pressed", null);
        await waitFor("the changed password in Apple Passwords", async () => (fake.savedLogins().find((l) => l.user === kept.user)?.password === changed ? true : null), 20_000);
        const copies = fake.savedLogins().filter((l) => l.user === kept.user);
        assert(copies.length === 1, "the login is changed, not added again", copies.length);
        return { engine: engineName, title: prompt.copy.title };
      } finally {
        await tab.close();
      }
    },
  };
}
